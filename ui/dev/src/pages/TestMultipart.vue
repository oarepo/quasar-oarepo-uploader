<template>
  <q-page padding>
    <OARepoUploader
      :url="filesAPI"
      :multipart-threshold="1024">
    </OARepoUploader>
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
      filesAPI: 'https://localhost:5000/api/draft/records/1/files/'
    }
  },
  created () {
    this.fetchFiles()
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
