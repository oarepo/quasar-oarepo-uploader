import { QUploaderBase } from 'quasar'
import slugify from 'slugify'
import PromisePool from '@supercharge/promise-pool'

function getFn (prop) {
  return typeof prop === 'function'
      ? prop
      : () => prop
}

const urlSafeFilename = fn => slugify(fn, { remove: /"<>#%\{\}\|\\\^~\[\]`;\?:@=&/g });


export default {
  name: 'OARepoUploader',
  mixins: [QUploaderBase],
  props: {
    label: {
      type: String,
      default: 'OARepo Uploader'
    },
    method: {
      type: [Function, String],
      default: 'PUT'
    },
    url: [Function, String],
    accept: [Function, String],
    headers: [Function, Array],
    batch: [Function, Boolean],
    multipartThreshold: {
      type: [Function, Number],
      default: 1024*1024*500 // Consider files larger than 500 MiB to be multipart uploaded
    },
    maxConcurrency: {
      type: [Function, Number],
      default: 5 // How many upload promises is allowed to run in parallel
    },
    factory: Function
  },
  data() {
    return {
      xhrs: [],
      promises: [],
      workingThreads: 0,
      chunkQueue: [],
      uploadedChunks: []
    }
  },
  computed: {
    xhrProps () {
      return {
        url: getFn(this.url),
        method: getFn(this.method),
        headers: getFn(this.headers),
        batch: getFn(this.batch),
        maxConcurrency: getFn(this.maxConcurrency)
      }
    },
    // [REQUIRED]
    // we're working on uploading files
    isUploading () {
      return this.workingThreads > 0
    },
    // [optional]
    // shows overlay on top of the
    // uploader signaling it's waiting
    // on something (blocks all controls)
    isBusy () {
      return this.promises.length > 0
    },

  },
  methods: {
    // [REQUIRED]
    // abort and clean up any process
    // that is in progress
    abort () {
      console.warn('oarepo-uploader: aborting upload', this.xhrs)
      this.xhrs.forEach(x => {
        x.abort()
      })

      if (this.promises.length > 0) {
        this.abortPromises = true
      }
    },
    // [REQUIRED]
    upload () {
      console.debug('oarepo-uploader: starting upload')
      if (this.canUpload === false) {
        return
      }

      const queue = this.queuedFiles.slice(0)
      if (queue.length === 0) {
        return
      }
      this.queuedFiles = []

      const file = queue[0]
      this.__runFactory(file)
    },
    __getProp (factory, name, arg) {
      return factory[name] !== undefined
          ? getFn(factory[name])(arg)
          : this.xhrProps[name](arg)
    },
    __runFactory (file) {
      this.workingThreads++
      if (typeof this.factory !== 'function') {
        this.__createMultipartUpload(file, {})
        return
      }

      const res = this.factory(file)

      if (!res) {
        this.$emit(
            'factory-failed',
            new Error('oarepo-uploader: factory() does not return properly'),
            file
        )
        this.workingThreads--
      } else if (typeof res.catch === 'function' && typeof res.then === 'function') {
        this.promises.push(res)

        const failed = err => {
          if (this._isBeingDestroyed !== true && this._isDestroyed !== true) {
            this.promises = this.promises.filter(p => p !== res)

            if (this.promises.length === 0) {
              this.abortPromises = false
            }

            this.queuedFiles = this.queuedFiles.concat(file)
            this.__updateFile(file, 'failed')

            this.$emit('factory-failed', err, file)
            this.workingThreads--
          }
        }

        res.then(factory => {
          if (this.abortPromises === true) {
            failed(new Error('Aborted'))
          } else if (this._isBeingDestroyed !== true && this._isDestroyed !== true) {
            this.__createMultipartUpload(file, factory)
            this.promises = this.promises.filter(p => p !== res)
            return factory
          }
        }).catch(failed)
      } else {
        this.__createMultipartUpload(file, res || {})
      }
    },
    __createMultipartUpload (file, factory) {
      const xhr = new XMLHttpRequest()
      let url = this.__getProp(factory, 'url', file)

      if (!url) {
        this.workingThreads--
        return
      }

      if (file.size < this.multipartThreshold) {
        // Upload whole file in a single part
        this.__uploadFile(file, factory)
        return
      }

      url = `${url}?multipart=true`
      console.debug('oarepo-uploader: create multipart upload', url)

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4) {
          return
        }

        if (xhr.status && xhr.status === 201) {
          const response = JSON.parse(xhr.responseText)
          console.debug('oarepo-uploader: multipart upload created', response)
          this.$emit('multipart-created', {
            file,
            xhr,
            response
          })
          this.__uploadParts(factory, file, response.multipart_upload)
        } else {
          console.error('oarepo-uploader: failed to create multipart upload', xhr.response)
          this.$emit('failed', {
            file,
            xhr
          })
          this.__fileUploadFailed(file, { file, xhr })
        }
        this.workingThreads--
        this.xhrs = this.xhrs.filter(x => x !== xhr)
      }

      xhr.open('POST', url)
      xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8")

      const headers = this.__getProp(factory, 'headers', file)
      headers && headers.forEach(head => {
        xhr.setRequestHeader(head.name, head.value)
      })

      this.__setFileUploading(file, xhr)

      this.xhrs.push(xhr)

      const body = JSON.stringify({
        "key": urlSafeFilename(file.name),
        "size": file.size,
        "multipart_content_type": file.type || 'application/octet-stream'
      })
      xhr.send(body)
    },
    __abortMultipartUpload (url) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()

        xhr.open('POST', url)

        xhr.onload = () => {
          this.xhrs = this.xhrs.filter(x => x !== xhr)
          if (xhr.status && xhr.status === 200) {
            resolve(xhr.response)
          } else {
            reject({status: this.status, statusText: xhr.statusText})
          }
        }
        xhr.onerror = () => {
          this.xhrs = this.xhrs.filter(x => x !== xhr)
          reject({
            status: this.status,
            statusText: xhr.statusText
          });
        }

        this.xhrs.push(xhr)
        xhr.send()
      })
    },
    __completeMultipartUpload (url, parts) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()

        xhr.open('POST', url)
        xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8")

        xhr.onload = () => {
          this.xhrs = this.xhrs.filter(x => x !== xhr)
          if (xhr.status && xhr.status === 200) {
            resolve(xhr.response)
          } else {
            reject({status: this.status, statusText: xhr.statusText})
          }
        }
        xhr.onerror = () => {
          this.xhrs = this.xhrs.filter(x => x !== xhr)
          reject({
            status: this.status,
            statusText: xhr.statusText
          });
        }

        this.xhrs.push(xhr)
        const body = JSON.stringify({
          parts: parts
        })
        xhr.send(body)
      })
    },
    __setFileUploading (file, xhr) {
      this.__updateFile(file, 'uploading', 0)
      file.xhr = xhr
      file.__abort = () => {
        xhr.abort()
      }
      this.$emit('uploading', {
        file,
        xhr
      })
    },
    __buildPartQueue (partsUrl, numParts) {
      return new Array(numParts)
          .fill()
          .map((_, index) => {
            return { partId: index+1, partUrl: partsUrl[index]}
          })
    },
    __uploadParts (factory, file, multipartUploadConfig) {
      const { chunk_size, abort_url, num_chunks, complete_url, parts_url } = multipartUploadConfig,
          concurrency = this.__getProp(factory, 'maxConcurrency', file)

      let
          uploadIndexSize = 0,
          uploadedSize = 0,
          maxUploadSize = file.size,
          aborted

      this.partQueue = this.__buildPartQueue(parts_url, num_chunks)
      this.uploadedParts = []

      console.debug('oarepo-uploader: uploading parts', multipartUploadConfig, this.partQueue)

      const uploadFailed = (file) => {
        this.workingThreads++
        console.warn('oarepo-uploader: aborting multipart upload')

        this.__abortMultipartUpload(abort_url)
          .then((response) => {
            console.debug('oarepo-uploader: multipart upload aborted')
          }).finally(() => {
            this.workingThreads--
            this.__fileUploadFailed(file, {file})
          })
      }

      const uploadComplete = (parts) => {
        this.workingThreads++
        console.debug('oarepo-uploader: completing multipart upload')

        this.__completeMultipartUpload(complete_url, parts)
          .then((response) => {
            console.debug('oarepo-uploader: multipart upload complete', response)
            this.__fileUploaded(file, {file})
          }).catch((err) => {
            console.error('oarepo-uploader: failed to complete multipart upload', err)
            this.__fileUploadFailed(file, {file})
          }).finally(() => {
            this.workingThreads--
        })
      }

      // TODO: mechanism to retry failed chunks?
      PromisePool
        .withConcurrency(concurrency)
        .for(this.partQueue)
        .process(async part => {
          console.debug('oarepo-uploader: uploading part', part.partId)
          this.workingThreads++

          const { etag, err } = await this.__uploadPart(factory, file, part, chunk_size)

          this.workingThreads--

          if (etag) {
            console.debug('oarepo-uploader: part uploaded', part.partId, etag)
            return {ETag: etag, PartNumber: part.partId}
          } else if (err) {
            console.error('oarepo-uploader: part upload failed', part.partId, err)
          }
        }).then((result) => {
          const parts = result.results.filter(part => part)

          if (parts.length === num_chunks) {
            console.debug('oarepo-uploader: all parts uploaded', parts)
            uploadComplete(parts)
          } else {
            console.error(`oarepo-uploader: failed to upload ${num_chunks - parts.length} parts`, result)
            uploadFailed(file)
          }
        }).catch((err) => {
          console.error('oarepo-uploader: failed to upload parts', err)
          uploadFailed(file)
        })
    },
    __uploadPart (factory, file, part, partSize) {
      return new Promise((resolve, reject) => {
        const
            xhr = new XMLHttpRequest(),
            begin = (part.partId - 1) * partSize,
            end = (begin + partSize) > file.size ? file.size : (begin + partSize),
            chunk = file.slice(begin, end),
            headers = this.__getProp(factory, 'headers', file)
        console.debug('oarepo-uploader: uploading chunk', begin, end, part.partId)


        xhr.open(this.__getProp(factory, 'method', file), part.partUrl)

        headers && headers.forEach(head => {
          xhr.setRequestHeader(head.name, head.value)
        })

        xhr.onload = () => {
          this.xhrs = this.xhrs.filter(x => x !== xhr)
          if (xhr.status && xhr.status === 200) {
            resolve({etag: xhr.getResponseHeader('ETag')})
            // this.uploadedParts.push(xhr.responseText)
            // console.debug('chunk uploaded', chunkId, this.uploadedParts)
          } else {
            reject({err:{status: this.status, statusText: xhr.statusText}})
            // console.warn('part upload failed', part.partId)
            // this.partQueue.push(chunkId)
          }
        }
        xhr.onerror = () => {
          this.xhrs = this.xhrs.filter(x => x !== xhr)
          reject({
            err:{
              status: this.status,
              statusText: xhr.statusText
            }});
        }

        this.xhrs.push(xhr)
        xhr.send(chunk)
      })
    },
    __uploadFile (file, factory) {
      const xhr = new XMLHttpRequest()
      let url = this.__getProp(factory, 'url', file)

      if (!url) {
        this.workingThreads--
        return
      }

      url = `${url}/${urlSafeFilename(file.name)}`.replace(/([^:]\/)\/+/g, "$1")
      console.debug('oarepo-uploader: direct upload', url)

      let
          uploadIndexSize = 0,
          uploadedSize = 0,
          maxUploadSize = 0,
          aborted

      xhr.upload.addEventListener('progress', e => {
        if (aborted === true) {
          return
        }

        const loaded = Math.min(maxUploadSize, e.loaded)

        this.uploadedSize += loaded - uploadedSize
        uploadedSize = loaded

        let size = uploadedSize - uploadIndexSize
        const
            uploaded = size > file.size

        if (uploaded) {
          size -= file.size
          uploadIndexSize += file.size
          this.__updateFile(file, 'uploading', file.size)
        } else {
          this.__updateFile(file, 'uploading', size)
        }
      }, false)

      xhr.onreadystatechange = () => {
        console.debug(xhr)
        if (xhr.readyState < 4) {
          return
        }

        // TODO: check for 413 Entity too large and retry with multipart
        if (xhr.status && xhr.status === 201) {
          this.__fileUploaded(file, { file, xhr })
        } else {
          console.error('oarepo-uploader: direct upload failed', xhr)
          aborted = true
          this.uploadedSize -= uploadedSize
          this.__fileUploadFailed(file, { file, xhr })
        }

        this.workingThreads--
        console.debug(this.workingThreads)
        this.xhrs = this.xhrs.filter(x => x !== xhr)
      }

      xhr.open(
          this.__getProp(factory, 'method', file),
          url
      )

      const headers = this.__getProp(factory, 'headers', file)
      headers && headers.forEach(head => {
        xhr.setRequestHeader(head.name, head.value)
      })

      this.__setFileUploading(file, xhr)
      maxUploadSize += file.size

      xhr.onerror = function(e) {
        console.error("Error Status: " + e.target.status);
      };

      this.xhrs.push(xhr)
      xhr.send(new Blob([file]))
    },
    __fileUploadFailed (file, args) {
      this.queuedFiles = this.queuedFiles.concat(file)
      this.__updateFile(file, 'failed')
      this.$emit('failed', args)
    },
    __fileUploaded (file, args) {
      console.debug('oarepo-uploader: file uploaded', file)
      this.uploadedFiles = this.uploadedFiles.concat(file)
      this.__updateFile(file, 'uploaded')
      this.$emit('uploaded', args)
    }
  }
}
