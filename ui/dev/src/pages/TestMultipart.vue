<template>
  <q-page padding>
    <OARepoUploader
      :url="filesAPI"
      :multipart-threshold="mpThreshold"
      :max-concurrency="concurrency"
      :headers="[{name: 'Access-Control-Allow-Origin', value: '*'}]"
    >
    </OARepoUploader>
    <h6>Settings</h6>
    <p>Upload URL: {{ filesAPI }}</p>
    <p>Concurrency: {{ concurrency }}</p>
    <p>Multipart Threshold: {{ mpThreshold }}</p>
    <h5>Uploaded files</h5>
    <q-item class="col-auto q-pa-lg"
            v-for="att in s3Files"
            clickable
            :key="att.key"
            @click="downloadFile(att)">
      <q-item-section>
        <q-item-label>{{ att.key }}</q-item-label>
        <q-item-label caption>{{ att.size }} kb</q-item-label>
      </q-item-section>
    </q-item>
  </q-page>
</template>
<script>
import { openURL } from 'quasar'

export default {
  data() {
    return {
      s3Bucket: '',
      s3Files: [],
    }
  },
  created () {
    this.fetchFiles()
  },
  computed: {
    filesAPI () {
      return process.env.RECORD_FILES_API || alert('RECORD_FILES_API env variable not set')
    },
    mpThreshold () {
      return parseInt(process.env.MULTIPART_THRESHOLD) || 1024 * 1024 * 50
    },
    concurrency () {
      return parseInt(process.env.CONCURRENCY) || 5
    }
  },
  methods: {
    downloadFile(file) {
      openURL(`${this.filesAPI}${file.key}`)
    },
    fetchFiles() {
      console.log('fetching files')
      fetch(this.filesAPI)
        .then((response) => {
          response.json().then((data) => {
            this.s3Files = data
          })
        })
        .catch((err) => {
          console.error(err)
        })
    }
  }
}
</script>
<style lang="sass" scoped>
.directive-target
  width: 50px
  height: 50px
</style>
