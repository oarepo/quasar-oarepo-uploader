import {QUploaderBase} from 'quasar'

const PromisePool = require('@supercharge/promise-pool')
const slugify = require('slugify')

function getFn(prop) {
    return typeof prop === 'function'
        ? prop
        : () => prop
}

const urlSafeFilename = fn => slugify(fn, {remove: /"<>#%\{\}\|\\\^~\[\]`;\?:@=&/g});


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
            default: 1024 * 1024 * 500 // Consider files larger than 500 MiB to be multipart uploaded
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
        }
    },
    computed: {
        xhrProps() {
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
        isUploading() {
            return this.workingThreads > 0
        },
        // [optional]
        // shows overlay on top of the
        // uploader signaling it's waiting
        // on something (blocks all controls)
        isBusy() {
            return this.promises.length > 0
        },

    },
    created() {
        this.$on('added', (files) => {
            this.__resetProgress(files)
        })
        this.$on('removed', () => {
            this.__resetProgress(this.files)
        })
    },
    methods: {
        // [REQUIRED]
        // abort and clean up any process
        // that is in progress
        abort() {
            console.warn('oarepo-uploader: aborting upload', this.xhrs)
            this.aborted = true
            this.xhrs.forEach(x => {
                x.abort()
            })

            if (this.promises.length > 0) {
                this.abortPromises = true
            }
        },
        // [REQUIRED]
        upload() {
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
        removeUploadedFiles () {
            if (!this.disable) {
                this.files = this.files.filter(f => {
                    if (f.__status !== 'uploaded') {
                        return true
                    }

                    f._img !== void 0 && window.URL.revokeObjectURL(f._img.src)

                    return false
                })
                this.__resetProgress(this.files)
                this.uploadedFiles = []
            }
        },
        __getProp(factory, name, arg) {
            return factory[name] !== undefined
                ? getFn(factory[name])(arg)
                : this.xhrProps[name](arg)
        },
        __runFactory(file) {
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
        __xhrCreateMultipartUpload(url, factory, file) {
            const xhr = new XMLHttpRequest()
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
                    this.__fileUploadFailed(file, {file, xhr})
                }
                this.workingThreads--
                this.xhrs = this.xhrs.filter(x => x !== xhr)
            }

            xhr.open('POST', url)

            this.__setXhrHeaders(xhr, factory, file)
            xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8")

            return xhr
        },
        __xhrAbortMultipartUpload(url, factory, file, resolve, reject) {
            const xhr = new XMLHttpRequest()

            xhr.open('POST', url)
            this.__setXhrHeaders(xhr, factory, file)

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
            xhr.onabort = () => {
                this.xhrs = this.xhrs.filter(x => x !== xhr)
                reject({
                    status: this.status,
                    statusText: xhr.statusText
                });
            }

            return xhr
        },
        __xhrUploadMultipartPart(part, factory, file, onprogress, resolve, reject) {
            const xhr = new XMLHttpRequest()
            xhr.open(this.__getProp(factory, 'method', file), part.partUrl)
            this.__setXhrHeaders(xhr, factory, file)


            xhr.upload.addEventListener('progress', e => {
                onprogress(e)
            })
            xhr.onload = () => {
                this.xhrs = this.xhrs.filter(x => x !== xhr)
                if (xhr.status && xhr.status === 200) {
                    resolve({etag: xhr.getResponseHeader('ETag')})
                } else {
                    reject({err: {status: this.status, statusText: xhr.statusText}})
                }
            }
            xhr.onerror = () => {
                this.xhrs = this.xhrs.filter(x => x !== xhr)
                reject({
                    err: {
                        status: this.status,
                        statusText: xhr.statusText
                    }
                });
            }
            xhr.onabort = () => {
                this.xhrs = this.xhrs.filter(x => x !== xhr)
                reject({
                    status: this.status,
                    statusText: xhr.statusText
                });
            }
            return xhr
        },
        __xhrCompleteMultipartUpload(url, factory, file, resolve, reject) {
            const xhr = new XMLHttpRequest()

            xhr.open('POST', url)
            xhr.setRequestHeader("Content-Type", "application/json;charset=UTF-8")
            this.__setXhrHeaders(xhr, factory, file)

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
            xhr.onabort = () => {
                this.xhrs = this.xhrs.filter(x => x !== xhr)
                reject({
                    status: this.status,
                    statusText: xhr.statusText
                });
            }
            return xhr
        },
        __xhrUploadFile(url, factory, file) {
            const xhr = new XMLHttpRequest()
            let aborted,
                uploadSize = 0

            xhr.open(this.__getProp(factory, 'method', file), url)
            this.__setXhrHeaders(xhr, factory, file)

            xhr.upload.addEventListener('progress', e => {
                if (!aborted) {
                    uploadSize = this.__updateUploadProgress(e.loaded, file, uploadSize)
                }
            }, false)

            xhr.onreadystatechange = () => {
                console.debug(xhr)
                if (xhr.readyState < 4) {
                    return
                }

                // TODO: check for 413 Entity too large and retry with multipart
                if (xhr.status && xhr.status === 201) {
                    this.__fileUploaded(file, {file, xhr})
                } else {
                    console.error('oarepo-uploader: direct upload failed', xhr)
                    aborted = true
                    this.uploadedSize -= uploadSize
                    this.__fileUploadFailed(file, {file, xhr})
                }

                this.workingThreads--
                this.xhrs = this.xhrs.filter(x => x !== xhr)
            }
            xhr.onerror = function (e) {
                console.error("Error Status: " + e.target.status)
                aborted = true
                this.uploadedSize -= uploadSize
                this.__fileUploadFailed(file, {file, xhr})
                this.workingThreads--
                this.xhrs = this.xhrs.filter(x => x !== xhr)
            }

            return xhr
        },
        __updateUploadProgress(loadedSize, file, uploadedSize) {
            const loaded = Math.min(file.size, loadedSize)

            this.uploadedSize += loaded - uploadedSize
            uploadedSize = loaded

            let size = uploadedSize
            const
                uploaded = size > file.size

            if (uploaded) {
                size -= file.size
                this.__updateFile(file, 'uploading', file.size)
            } else {
                this.__updateFile(file, 'uploading', size)
            }
            return uploadedSize
        },
        __createMultipartUpload(file, factory) {
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

            const xhr = this.__xhrCreateMultipartUpload(url, factory, file)

            this.__setFileUploading(file, xhr)

            this.xhrs.push(xhr)

            const body = JSON.stringify({
                "key": urlSafeFilename(file.name),
                "size": file.size,
                "multipart_content_type": file.type || 'application/octet-stream'
            })
            xhr.send(body)
        },
        __abortMultipartUpload(url, factory, file) {
            return new Promise((resolve, reject) => {
                const xhr = this.__xhrAbortMultipartUpload(url, factory, file, resolve, reject)
                this.xhrs.push(xhr)
                xhr.send()
            })
        },
        __completeMultipartUpload(parts, url, factory, file) {
            return new Promise((resolve, reject) => {
                const xhr = this.__xhrCompleteMultipartUpload(url, factory, file, resolve, reject)

                this.xhrs.push(xhr)
                const body = JSON.stringify({
                    parts: parts
                })
                xhr.send(body)
            })
        },
        __multipartUploadCompleteHandler(parts, complete_url, factory, file) {
            this.workingThreads++
            console.debug('oarepo-uploader: completing multipart upload')

            this.__completeMultipartUpload(parts, complete_url, factory, file)
                .then((response) => {
                    console.debug('oarepo-uploader: multipart upload complete', response)
                    this.__fileUploaded(file, {file})
                }).catch((err) => {
                console.error('oarepo-uploader: failed to complete multipart upload', err)
                this.__fileUploadFailed(file, {file})
            }).finally(() => {
                this.workingThreads--
            })
        },
        __multipartUploadFailedHandler(abort_url, factory, file) {
            this.uploadedSize = 0
            this.workingThreads++
            console.warn('oarepo-uploader: aborting multipart upload')

            this.__abortMultipartUpload(abort_url, factory, file)
                .then((response) => {
                    console.debug('oarepo-uploader: multipart upload aborted')
                }).finally(() => {
                    this.workingThreads--
                    this.__fileUploadFailed(file, {file})
                })
        },
        __setFileUploading(file, xhr) {
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
        __setXhrHeaders(xhr, factory, file) {
            const headers = this.__getProp(factory, 'headers', file)
            headers && headers.forEach(head => {
                xhr.setRequestHeader(head.name, head.value)
            })
        },
        __buildPartQueue(partsUrl, numParts) {
            return new Array(numParts)
                .fill()
                .map((_, index) => {
                    return {partId: index + 1, partUrl: partsUrl[index]}
                })
        },
        __resetProgress(files) {
            console.debug('resetting progress counters')
            this.uploadSize = 0
            this.uploadedSize = 0
            files.forEach(file => {
                if (file.__status === 'idle' || file.__status === 'uploading') {
                    this.uploadSize += file.size
                }
            })
        },
        __uploadParts(factory, file, multipartUploadConfig) {
            const {chunk_size, abort_url, num_chunks, complete_url, parts_url} = multipartUploadConfig,
                concurrency = this.__getProp(factory, 'maxConcurrency', file)

            let aborted = this.aborted

            this.partQueue = this.__buildPartQueue(parts_url, num_chunks)
            this.chunkProgress = new Array(num_chunks)
                .fill()
                .map((_, index) => {
                    return 0
                })

            console.debug('oarepo-uploader: uploading parts', multipartUploadConfig, this.partQueue)

            const that = this
            // TODO: mechanism to retry failed chunks?
            PromisePool
                .withConcurrency(concurrency)
                .for(this.partQueue)
                .process(async (part) => {
                    if (that.aborted) {
                        return
                    }

                    console.debug('oarepo-uploader: uploading part', part.partId)
                    that.workingThreads++

                    const {etag, err} = await that.__uploadPart(factory, file, part, chunk_size)

                    that.workingThreads--

                    if (etag) {
                        console.debug('oarepo-uploader: part uploaded', part.partId, etag)
                        return {ETag: etag, PartNumber: part.partId}
                    } else {
                        console.error('oarepo-uploader: part upload failed', part.partId, err)
                    }
                }).then((result) => {
                    const parts = result.results.filter(part => part)

                    if (parts.length === num_chunks) {
                        console.debug('oarepo-uploader: all parts uploaded', parts)
                        this.__multipartUploadCompleteHandler(parts, complete_url, factory, file)
                    } else {
                        aborted = true
                        console.error(`oarepo-uploader: failed to upload ${num_chunks - parts.length} parts`, result)
                        this.__multipartUploadFailedHandler(abort_url, factory, file)
                    }
                }).catch((err) => {
                    aborted = true
                    console.error('oarepo-uploader: failed to upload parts', err)
                    this.__multipartUploadFailedHandler(abort_url, factory, file)
                })
        },
        __uploadPart(factory, file, part, partSize) {
            return new Promise((resolve, reject) => {
                const _progressCallback = e => {
                    this.chunkProgress[part.partId] = Math.min(partSize, e.loaded)
                    this.uploadedSize = this.chunkProgress.reduce((a, b) => {
                        return a + b;
                    }, 0)

                    this.__updateFile(file, 'uploading', Math.min(file.size, this.uploadedSize))
                }

                const
                    xhr = this.__xhrUploadMultipartPart(part, factory, file, _progressCallback, resolve, reject),
                    begin = (part.partId - 1) * partSize,
                    end = (begin + partSize) > file.size ? file.size : (begin + partSize),
                    chunk = file.slice(begin, end)

                console.debug('oarepo-uploader: uploading chunk', begin, end, part.partId)

                this.xhrs.push(xhr)
                xhr.send(chunk)
            })
        },
        __uploadFile(file, factory) {
            let url = this.__getProp(factory, 'url', file)

            if (!url) {
                this.workingThreads--
                return
            }

            url = `${url}/${urlSafeFilename(file.name)}`.replace(/([^:]\/)\/+/g, "$1")
            console.debug('oarepo-uploader: direct upload', url)


            const xhr = this.__xhrUploadFile(url, factory, file)

            this.__setFileUploading(file, xhr)

            this.xhrs.push(xhr)
            xhr.send(new Blob([file]))
        },
        __fileUploadFailed(file, args) {
            this.queuedFiles = this.queuedFiles.concat(file)
            this.__updateFile(file, 'failed')
            this.$emit('failed', args)
        },
        __fileUploaded(file, args) {
            console.debug('oarepo-uploader: file uploaded', file)
            this.uploadedFiles = this.uploadedFiles.concat(file)
            this.__updateFile(file, 'uploaded')
            this.$emit('uploaded', args)
        }
    }
}
