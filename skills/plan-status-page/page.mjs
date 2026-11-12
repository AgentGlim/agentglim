#!/usr/bin/env node
import {build} from './build.mjs';
if(process.argv[2]!=='build' || !process.argv[3]){console.error('Usage: node page.mjs build PROJECT_DIRECTORY');process.exitCode=2;}
else try{console.log(JSON.stringify(build(process.argv[3])));}catch(e){console.error(e.message);process.exitCode=1;}
