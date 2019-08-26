const { Plugin } = require('@uppy/core')
const { Socket, Provider, RequestClient } = require('@uppy/companion-client')
const EventTracker = require('@uppy/utils/lib/EventTracker')
const emitSocketProgress = require('@uppy/utils/lib/emitSocketProgress')
const getSocketHost = require('@uppy/utils/lib/getSocketHost')
const RateLimitedQueue = require('@uppy/utils/lib/RateLimitedQueue')
const Uploader = require('./MultipartUploader')

function assertServerError (res) {
  if (res && res.error) {
    const error = new Error(res.message)
    Object.assign(error, res.error)
    throw error
  }
  return res
}

module.exports = class AwsS3Multipart extends Plugin {
  static VERSION = require('../package.json').version

  constructor (uppy, opts) {
    super(uppy, opts)
    this.type = 'uploader'
    this.id = this.opts.id || 'AwsS3Multipart'
    this.title = 'AWS S3 Multipart'
    this.client = new RequestClient(uppy, opts)

    const defaultOptions = {
      timeout: 30 * 1000,
      limit: 0,
      createMultipartUpload: this.createMultipartUpload.bind(this),
      listParts: this.listParts.bind(this),
      prepareUploadPart: this.prepareUploadPart.bind(this),
      abortMultipartUpload: this.abortMultipartUpload.bind(this),
      completeMultipartUpload: this.completeMultipartUpload.bind(this)
    }

    this.opts = { ...defaultOptions, ...opts }

    this.upload = this.upload.bind(this)

    this.requests = new RateLimitedQueue(this.opts.limit)

    this.uploaders = Object.create(null)
    this.uploaderEvents = Object.create(null)
    this.uploaderSockets = Object.create(null)
  }

  /**
   * Clean up all references for a file's upload: the MultipartUploader instance,
   * any events related to the file, and the Companion WebSocket connection.
   *
   * Set `opts.abort` to tell S3 that the multipart upload is cancelled and must be removed.
   * This should be done when the user cancels the upload, not when the upload is completed or errored.
   */
  resetUploaderReferences (fileID, opts = {}) {
    if (this.uploaders[fileID]) {
      this.uploaders[fileID].abort({ really: opts.abort || false })
      this.uploaders[fileID] = null
    }
    if (this.uploaderEvents[fileID]) {
      this.uploaderEvents[fileID].remove()
      this.uploaderEvents[fileID] = null
    }
    if (this.uploaderSockets[fileID]) {
      this.uploaderSockets[fileID].close()
      this.uploaderSockets[fileID] = null
    }
  }

  assertHost () {
    if (!this.opts.companionUrl) {
      throw new Error('Expected a `companionUrl` option containing a Companion address.')
    }
  }

  createMultipartUpload (file) {
    this.assertHost()

    const metadata = {}

    Object.keys(file.meta).map(key => {
      if (file.meta[key] != null) {
        metadata[key] = file.meta[key].toString()
      }
    })

    return this.client.post('s3/multipart', {
      filename: file.name,
      type: file.type,
      metadata
    }).then(assertServerError)
  }

  listParts (file, { key, uploadId }) {
    this.assertHost()

    const filename = encodeURIComponent(key)
    return this.client.get(`s3/multipart/${uploadId}?key=${filename}`)
      .then(assertServerError)
  }

  prepareUploadPart (file, { key, uploadId, number }) {
    this.assertHost()

    const filename = encodeURIComponent(key)
    return this.client.get(`s3/multipart/${uploadId}/${number}?key=${filename}`)
      .then(assertServerError)
  }

  completeMultipartUpload (file, { key, uploadId, parts }) {
    this.assertHost()

    const filename = encodeURIComponent(key)
    const uploadIdEnc = encodeURIComponent(uploadId)
    return this.client.post(`s3/multipart/${uploadIdEnc}/complete?key=${filename}`, { parts })
      .then(assertServerError)
  }

  abortMultipartUpload (file, { key, uploadId }) {
    this.assertHost()

    const filename = encodeURIComponent(key)
    const uploadIdEnc = encodeURIComponent(uploadId)
    return this.client.delete(`s3/multipart/${uploadIdEnc}?key=${filename}`)
      .then(assertServerError)
  }

  uploadFile (file) {
    return new Promise((resolve, reject) => {
      const onStart = (data) => {
        const cFile = this.uppy.getFile(file.id)
        this.uppy.setFileState(file.id, {
          s3Multipart: {
            ...cFile.s3Multipart,
            key: data.key,
            uploadId: data.uploadId,
            parts: []
          }
        })
      }

      const onProgress = (bytesUploaded, bytesTotal) => {
        this.uppy.emit('upload-progress', file, {
          uploader: this,
          bytesUploaded: bytesUploaded,
          bytesTotal: bytesTotal
        })
      }

      const onError = (err) => {
        this.uppy.log(err)
        this.uppy.emit('upload-error', file, err)
        err.message = `Failed because: ${err.message}`

        this.resetUploaderReferences(file.id)
        reject(err)
      }

      const onSuccess = (result) => {
        const uploadResp = {
          uploadURL: result.location
        }

        this.resetUploaderReferences(file.id)

        this.uppy.emit('upload-success', file, uploadResp)

        if (result.location) {
          this.uppy.log('Download ' + upload.file.name + ' from ' + result.location)
        }

        resolve(upload)
      }

      const onPartComplete = (part) => {
        // Store completed parts in state.
        const cFile = this.uppy.getFile(file.id)
        if (!cFile) {
          return
        }
        this.uppy.setFileState(file.id, {
          s3Multipart: {
            ...cFile.s3Multipart,
            parts: [
              ...cFile.s3Multipart.parts,
              part
            ]
          }
        })

        this.uppy.emit('s3-multipart:part-uploaded', cFile, part)
      }

      const upload = new Uploader(file.data, {
        // .bind to pass the file object to each handler.
        createMultipartUpload: this.requests.wrapPromiseFunction(
          this.opts.createMultipartUpload.bind(this, file)),
        listParts: this.requests.wrapPromiseFunction(
          this.opts.listParts.bind(this, file)),
        prepareUploadPart: this.opts.prepareUploadPart.bind(this, file),
        completeMultipartUpload: this.requests.wrapPromiseFunction(
          this.opts.completeMultipartUpload.bind(this, file)),
        abortMultipartUpload: this.requests.wrapPromiseFunction(
          this.opts.abortMultipartUpload.bind(this, file)),

        onStart,
        onProgress,
        onError,
        onSuccess,
        onPartComplete,

        limit: this.opts.limit || 5,
        ...file.s3Multipart
      })

      this.uploaders[file.id] = upload
      this.uploaderEvents[file.id] = new EventTracker(this.uppy)

      const queuedRequest = this.requests.run(() => {
        if (!file.isPaused) {
          upload.start()
        }
        // Don't do anything here, the caller will take care of cancelling the upload itself
        // using resetUploaderReferences(). This is because resetUploaderReferences() has to be
        // called when this request is still in the queue, and has not been started yet, too. At
        // that point this cancellation function is not going to be called.
        return () => {}
      })

      this.onFileRemove(file.id, (removed) => {
        queuedRequest.abort()
        this.resetUploaderReferences(file.id, { abort: true })
        resolve(`upload ${removed.id} was removed`)
      })

      this.onCancelAll(file.id, () => {
        queuedRequest.abort()
        this.resetUploaderReferences(file.id, { abort: true })
        resolve(`upload ${file.id} was canceled`)
      })

      this.onFilePause(file.id, (isPaused) => {
        if (isPaused) {
          upload.pause()
        } else {
          upload.start()
        }
      })

      this.onPauseAll(file.id, () => {
        upload.pause()
      })

      this.onResumeAll(file.id, () => {
        upload.start()
      })

      if (!file.isRestored) {
        this.uppy.emit('upload-started', file, upload)
      }
    })
  }

  uploadRemote (file) {
    this.resetUploaderReferences(file.id)

    this.uppy.emit('upload-started', file)
    if (file.serverToken) {
      return this.connectToServerSocket(file)
    }

    return new Promise((resolve, reject) => {
      const Client = file.remote.providerOptions.provider ? Provider : RequestClient
      const client = new Client(this.uppy, file.remote.providerOptions)
      client.post(
        file.remote.url,
        {
          ...file.remote.body,
          protocol: 's3-multipart',
          size: file.data.size,
          metadata: file.meta
        }
      ).then((res) => {
        this.uppy.setFileState(file.id, { serverToken: res.token })
        file = this.uppy.getFile(file.id)
        return file
      }).then((file) => {
        return this.connectToServerSocket(file)
      }).then(() => {
        resolve()
      }).catch((err) => {
        reject(new Error(err))
      })
    })
  }

  connectToServerSocket (file) {
    return new Promise((resolve, reject) => {
      const token = file.serverToken
      const host = getSocketHost(file.remote.companionUrl)
      const socket = new Socket({ target: `${host}/api/${token}`, autoOpen: false })
      this.uploaderSockets[socket] = socket
      this.uploaderEvents[file.id] = new EventTracker(this.uppy)

      this.onFileRemove(file.id, (removed) => {
        socket.send('pause', {})
        queuedRequest.abort()
        this.resetUploaderReferences(file.id, { abort: true })
        resolve(`upload ${file.id} was removed`)
      })

      this.onFilePause(file.id, (isPaused) => {
        socket.send(isPaused ? 'pause' : 'resume', {})
      })

      this.onPauseAll(file.id, () => socket.send('pause', {}))

      this.onCancelAll(file.id, () => {
        socket.send('pause', {})
        queuedRequest.abort()
        this.resetUploaderReferences(file.id)
        resolve(`upload ${file.id} was canceled`)
      })

      this.onResumeAll(file.id, () => {
        if (file.error) {
          socket.send('pause', {})
        }
        socket.send('resume', {})
      })

      this.onRetry(file.id, () => {
        socket.send('pause', {})
        socket.send('resume', {})
      })

      this.onRetryAll(file.id, () => {
        socket.send('pause', {})
        socket.send('resume', {})
      })

      socket.on('progress', (progressData) => emitSocketProgress(this, progressData, file))

      socket.on('error', (errData) => {
        this.uppy.emit('upload-error', file, new Error(errData.error))
        this.resetUploaderReferences(file.id)
        queuedRequest.done()
        reject(new Error(errData.error))
      })

      socket.on('success', (data) => {
        const uploadResp = {
          uploadURL: data.url
        }

        this.uppy.emit('upload-success', file, uploadResp)
        this.resetUploaderReferences(file.id)
        queuedRequest.done()
        resolve()
      })

      const queuedRequest = this.requests.run(() => {
        socket.open()
        if (file.isPaused) {
          socket.send('pause', {})
        }

        return () => socket.close()
      })
    })
  }

  upload (fileIDs) {
    if (fileIDs.length === 0) return Promise.resolve()

    const promises = fileIDs.map((id) => {
      const file = this.uppy.getFile(id)
      if (file.isRemote) {
        return this.uploadRemote(file)
      }
      return this.uploadFile(file)
    })

    return Promise.all(promises)
  }

  onFileRemove (fileID, cb) {
    this.uploaderEvents[fileID].on('file-removed', (file) => {
      if (fileID === file.id) cb(file.id)
    })
  }

  onFilePause (fileID, cb) {
    this.uploaderEvents[fileID].on('upload-pause', (targetFileID, isPaused) => {
      if (fileID === targetFileID) {
        // const isPaused = this.uppy.pauseResume(fileID)
        cb(isPaused)
      }
    })
  }

  onRetry (fileID, cb) {
    this.uploaderEvents[fileID].on('upload-retry', (targetFileID) => {
      if (fileID === targetFileID) {
        cb()
      }
    })
  }

  onRetryAll (fileID, cb) {
    this.uploaderEvents[fileID].on('retry-all', (filesToRetry) => {
      if (!this.uppy.getFile(fileID)) return
      cb()
    })
  }

  onPauseAll (fileID, cb) {
    this.uploaderEvents[fileID].on('pause-all', () => {
      if (!this.uppy.getFile(fileID)) return
      cb()
    })
  }

  onCancelAll (fileID, cb) {
    this.uploaderEvents[fileID].on('cancel-all', () => {
      if (!this.uppy.getFile(fileID)) return
      cb()
    })
  }

  onResumeAll (fileID, cb) {
    this.uploaderEvents[fileID].on('resume-all', () => {
      if (!this.uppy.getFile(fileID)) return
      cb()
    })
  }

  install () {
    const { capabilities } = this.uppy.getState()
    this.uppy.setState({
      capabilities: {
        ...capabilities,
        resumableUploads: true
      }
    })
    this.uppy.addUploader(this.upload)
  }

  uninstall () {
    const { capabilities } = this.uppy.getState()
    this.uppy.setState({
      capabilities: {
        ...capabilities,
        resumableUploads: false
      }
    })
    this.uppy.removeUploader(this.upload)
  }
}
