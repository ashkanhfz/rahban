import AdmZip from 'adm-zip';
import {sampleFiles} from '../server/source.js';
const zip=new AdmZip();for(const [name,text]of Object.entries(sampleFiles))zip.addFile(name,Buffer.from(text));zip.writeZip('sample-node.zip');console.log('Created sample-node.zip');
