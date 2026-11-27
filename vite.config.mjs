import { defineConfig } from 'vite';
import packageInfo from './package.json' with { type:'json' };

export default defineConfig({
  plugins:[{
    name:'hyper-bot-build-version',
    transformIndexHtml() {
      return [{tag:'meta',attrs:{name:'hyper-bot-version',content:packageInfo.version},injectTo:'head'}];
    }
  }]
});
