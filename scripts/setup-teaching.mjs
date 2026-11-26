import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {processEnvironment,root,systemTeachingPython,teachingPythonExecutable,teachingPythonHome,teachingRuntimeRoot} from '../server/config.mjs';

function run(python,args) {
  const result=spawnSync(python,args,{cwd:root,env:processEnvironment(),stdio:'inherit',windowsHide:true});
  if(result.error || result.status!==0){
    console.error('无法准备 Hyper Bot 的教培 Python 环境。请核对 Python 3.11 及以上版本和安装输出。');
    process.exit(result.status||1);
  }
}

if(!existsSync(teachingPythonExecutable)){
  const python=process.argv[2]||systemTeachingPython;
  run(python,['-c','import sys; sys.exit(sys.version_info < (3, 11))']);
  run(python,['-m','venv',teachingPythonHome]);
}
run(teachingPythonExecutable,['-m','pip','install','--disable-pip-version-check','-r',path.join(teachingRuntimeRoot,'requirements.txt')]);
console.log('Hyper Bot 的课件与练习生成组件已准备。');
