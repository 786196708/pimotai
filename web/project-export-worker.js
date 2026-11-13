import {packProject} from './project.js';

// The caller sends a structured clone, retaining ownership of live geometry.
// Keep the existing PMT validation and serialization entirely in this worker.
self.onmessage=({data})=>{
  try{
    const parts=Array.isArray(data?.parts)?data.parts.map(part=>({...part,base:{toArray:()=>part.matrix}})):data?.parts;
    const packed=packProject(parts,data?.title,data?.reference,data?.metadata);
    self.postMessage({buffer:packed.buffer},[packed.buffer]);
  }catch(error){
    self.postMessage({error:error instanceof Error?error.message:String(error)});
  }
};
