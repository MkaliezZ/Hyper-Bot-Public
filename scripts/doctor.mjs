import { configFor,dependencies,DSH_VERSION } from '../server/config.mjs';
const c=await configFor();
console.log(JSON.stringify({
  product:'Hyper Bot',data:c.data,model:c.model,providerConfigured:!!c.key,
  dsh:{version:DSH_VERSION,installed:c.sdk,webHost:c.dshWeb},
  hermes:c.hermes,workbench:c.workbench,blocked:dependencies(c)
},null,2));

