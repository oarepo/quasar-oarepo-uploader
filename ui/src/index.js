import { version } from '../package.json'

import OARepoUploader from './components/OARepoUploader'


export {
  version,
  OARepoUploader
}

export default {
  version,
  OARepoUploader,


  install (Vue) {
    Vue.component(OARepoUploader.name, OARepoUploader)

  }
}
