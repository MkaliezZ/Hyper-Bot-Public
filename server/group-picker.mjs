import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Problem} from './contracts.mjs';

const run=promisify(execFile);
const windowsPicker="[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -AssemblyName System.Windows.Forms; $d=New-Object Windows.Forms.FolderBrowserDialog; $d.Description='Hyper Bot'; $w=New-Object Windows.Forms.Form; $w.TopMost=$true; try { if($d.ShowDialog($w) -eq 'OK'){[Console]::Write($d.SelectedPath)} } finally {$d.Dispose();$w.Dispose()}";
const macPicker=`
try
  set selectedFolder to choose folder with prompt "选择 Hyper Bot 群组文件夹"
  return POSIX path of selectedFolder
on error number -128
  return ""
end try
`;
const linuxPicker=`
import os
import sys
import gi

gi.require_version('Gtk', '3.0')
from gi.repository import Gtk

if not Gtk.init_check()[0]:
    sys.exit(1)

picker = Gtk.FileChooserNative.new(
    '选择群组文件夹', None, Gtk.FileChooserAction.SELECT_FOLDER, '选择', '取消'
)
try:
    picker.set_current_folder(os.path.expanduser('~'))
    if picker.run() == Gtk.ResponseType.ACCEPT:
        sys.stdout.write(picker.get_filename() or '')
finally:
    picker.destroy()
`;
const commands={
  win32:['powershell.exe','-NoProfile','-STA','-EncodedCommand',Buffer.from(windowsPicker,'utf16le').toString('base64')],
  darwin:['/usr/bin/osascript','-e',macPicker],
  linux:['python3','-X','utf8','-c',linuxPicker]
};

let pending=false;
export async function chooseGroupFolder(){
  if(pending)throw new Problem(409,'文件夹窗口已打开。');
  const command=commands[process.platform];
  if(!command)throw new Problem(422,'请直接输入群组文件夹的绝对路径。');
  const [file,...args]=command;
  pending=true;
  try{
    const {stdout}=await run(file,args,{timeout:180000,windowsHide:true});
    return process.platform==='darwin'?stdout.replace(/\r?\n$/,''):stdout;
  }catch{
    throw new Problem(422,'无法打开系统文件夹选择器，请重试或直接输入文件夹路径。','group_folder_picker');
  }finally{pending=false;}
}
