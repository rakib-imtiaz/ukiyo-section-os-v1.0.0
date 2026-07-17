import type { NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { compileSection } from '../src/compiler/compile';
import type { SectionManifest } from '../src/shared/types';
import { db } from './db';
import { deployManifest } from './api';
import { sha256 } from './security';

function result(data:unknown){return {content:[{type:'text' as const,text:JSON.stringify(data,null,2)}],structuredContent:data as Record<string,unknown>};}
function failure(error:unknown){return {isError:true,content:[{type:'text' as const,text:error instanceof Error?error.message:'Section OS tool failed.'}]};}

export function createSectionOsMcpServer(shop:string,shopId:string){
  const server=new McpServer({name:'themebot',version:'1.0.0'});
  server.registerTool('validate_shopify_section',{
    title:'Validate Shopify section',description:'Validate a Section OS design contract without saving or deploying it.',
    inputSchema:{manifest:z.record(z.string(),z.unknown()).describe('Complete SectionManifest JSON object')},annotations:{readOnlyHint:true,openWorldHint:false},
  },async({manifest})=>{const compiled=compileSection(manifest);return result({valid:compiled.valid,issues:compiled.issues,stats:compiled.stats});});
  server.registerTool('compile_shopify_section',{
    title:'Compile Shopify section',description:'Compile a design contract into native Liquid, CSS, JavaScript, schema, and installation files.',
    inputSchema:{manifest:z.record(z.string(),z.unknown()).describe('Complete SectionManifest JSON object')},annotations:{readOnlyHint:true,openWorldHint:false},
  },async({manifest})=>result(compileSection(manifest)));
  server.registerTool('list_section_projects',{
    title:'List section projects',description:'List saved Section OS projects for the connected Shopify store.',inputSchema:{},annotations:{readOnlyHint:true,openWorldHint:false},
  },async()=>result({projects:await db.listProjects(shopId)}));
  server.registerTool('save_section_project',{
    title:'Save section project',description:'Validate and save a new modular section project with version 1.',
    inputSchema:{manifest:z.record(z.string(),z.unknown()).describe('Complete SectionManifest JSON object')},annotations:{destructiveHint:false,openWorldHint:false},
  },async({manifest})=>{try{const compiled=compileSection(manifest);if(!compiled.valid)return result(compiled);const typed=manifest as unknown as SectionManifest;const project=await db.createProject(shopId,typed);const version=await db.createVersion(project.id,typed,compiled.files,sha256(JSON.stringify(typed)));return result({project,version});}catch(error){return failure(error);}});
  server.registerTool('deploy_section_to_unpublished_theme',{
    title:'Deploy to unpublished theme',description:'Deploy a saved modular section to an unpublished Shopify theme. Requires explicit confirmation and refuses the published theme.',
    inputSchema:{project_id:z.string().describe('Saved Section OS project ID'),theme_id:z.string().describe('Shopify theme GID'),confirm_unpublished_theme:z.literal(true).describe('Explicit confirmation that the selected target is an unpublished theme')},annotations:{destructiveHint:true,openWorldHint:true},
  },async({project_id,theme_id})=>{try{const project=await db.getProject(project_id,shopId);if(!project)return failure(new Error('Project not found.'));return result(await deployManifest(shop,shopId,project.manifest,theme_id,project.id));}catch(error){return failure(error);}});
  return server;
}

export async function handleMcp(request:Request,response:Response,_next:NextFunction){
  const server=createSectionOsMcpServer(response.locals.shop,response.locals.shopId);
  try{
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
    await server.connect(transport);
    await transport.handleRequest(request,response,request.body);
    response.on('close',()=>{void transport.close();void server.close();});
  }catch(error){
    if(!response.headersSent)response.status(500).json({jsonrpc:'2.0',error:{code:-32603,message:error instanceof Error?error.message:'Internal server error'},id:null});
  }
}

export function rejectMcpMethod(_request:Request,response:Response){response.status(405).json({jsonrpc:'2.0',error:{code:-32000,message:'Method not allowed.'},id:null});}
