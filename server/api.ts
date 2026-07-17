import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { compileSection } from '../src/compiler/compile';
import { contractJsonSchema } from '../src/compiler/schema';
import type { SectionManifest } from '../src/shared/types';
import { config } from './config';
import { db } from './db';
import { createSubscription, getBillingStatus } from './billing';
import { applyInstallation, listThemes, prepareInstallation, rollbackFiles, shopifyStatus, themeDuplicate, type ThemeSnapshot } from './shopify';
import { currentShop, newSecret, rateLimit, requireSession, sha256 } from './security';
import { getClaudeStatusQuick } from './claude-connect';
import { getWorkspaceState } from './workspace';

type AsyncHandler = (request:Request,response:Response,next:NextFunction)=>Promise<unknown>;
const handle=(handler:AsyncHandler)=>(request:Request,response:Response,next:NextFunction)=>handler(request,response,next).catch(next);

export function apiKeyHash(key:string){return sha256(`${config.security.apiKeyPepper}:${key}`);}

export const requireApiKey=handle(async(request,response,next)=>{
  const authorization=request.headers.authorization??'';
  const token=authorization.startsWith('Bearer ')?authorization.slice(7):'';
  if(!token.startsWith('vso_live_')){response.status(401).json({error:'A valid Section OS API key is required.',code:'INVALID_API_KEY'});return;}
  const record=await db.findApiKey(apiKeyHash(token));
  if(!record){response.status(401).json({error:'The API key is invalid or revoked.',code:'INVALID_API_KEY'});return;}
  const shop=await db.getShopById(record.shop_id);
  if(!shop||shop.status!=='active'){response.status(401).json({error:'The connected Shopify store is inactive.',code:'SHOP_INACTIVE'});return;}
  response.locals.shop=shop.shop_domain;response.locals.shopId=shop.id;response.locals.apiKeyId=record.id;
  void db.touchApiKey(record.id);next();
});

async function shopForDomain(domain:string){
  let shop=await db.getShop(domain);
  if(!shop&&config.shopify.legacyShop===domain&&config.shopify.legacyToken){
    const {encrypt}=await import('./security');
    shop=await db.upsertShop({shop_domain:domain,access_token_cipher:encrypt(config.shopify.legacyToken),refresh_token_cipher:null,token_expires_at:null,refresh_token_expires_at:null,scopes:config.shopify.scopes});
  }
  if(!shop)throw new Error('Connected shop record not found.');
  return shop;
}

async function shopContext(response:Response){const domain=response.locals.shop as string;return {domain,record:await shopForDomain(domain)};}

export async function deployManifest(domain:string,shopId:string,manifest:SectionManifest,themeId:string,projectId:string|null=null,versionId:string|null=null){
  const result=compileSection(manifest);if(!result.valid)throw Object.assign(new Error('The section contract is invalid.'),{issues:result.issues});
  const themes=await listThemes(domain);const theme=themes.find((item)=>item.id===themeId);
  if(!theme)throw new Error('The selected theme does not exist.');
  if(theme.role==='MAIN')throw new Error('Published-theme lock is active. Select an unpublished duplicate.');
  const prepared=await prepareInstallation(domain,themeId,result.files);
  const pending=await db.createDeployment({shop_id:shopId,project_id:projectId,version_id:versionId,theme_id:themeId,theme_name:theme.name,status:'installing',snapshot:prepared.snapshot,installed_files:[]});
  try{
    const installed=await applyInstallation(domain,themeId,prepared.themeFiles);
    const complete=await db.finishDeployment(pending.id,'succeeded',installed);
    await db.audit(shopId,'section.deployed','merchant',{deploymentId:pending.id,themeId,files:installed});
    return {...complete,snapshot:undefined,theme:prepared.theme};
  }catch(error){await db.finishDeployment(pending.id,'failed',[],error instanceof Error?error.message:'Deployment failed');throw error;}
}

export function createApiRouter(){
  const router=Router();
  router.get('/session',handle(async(request,response)=>{
    const domain=currentShop(request);const record=domain?await shopForDomain(domain).catch(()=>null):null;
    const billing=domain&&record?await getBillingStatus(domain).catch(()=>({enabled:config.billing.enabled,active:false,mode:'error',subscriptions:[]})):null;
    // Onboarding gate state (dev-only; probe-free on this hot path). In production the gate is disabled.
    let claude={connected:true,method:null as string|null};let workspace={path:null as string|null,name:null as string|null,ready:true,projectCount:0};
    if(!config.production){
      const status=await getClaudeStatusQuick().catch(()=>null);
      claude={connected:Boolean(status?.connected),method:status?.method??null};
      const ws=await getWorkspaceState().catch(()=>null);
      workspace={path:ws?.path??null,name:ws?.name??null,ready:Boolean(ws?.ready),projectCount:ws?.projects.length??0};
    }
    response.json({authenticated:Boolean(record),shop:domain,persistent:db.persistent,shopify:shopifyStatus(),billing,claude,workspace});
  }));
  router.get('/shopify/status',(_request,response)=>response.json(shopifyStatus()));
  // Public contract JSON Schema — served unauthenticated so AI platforms can fetch the shape before connecting.
  router.get('/schema',(_request,response)=>response.json(contractJsonSchema()));
  router.use(requireSession);
  router.get('/shopify/themes',handle(async(_request,response)=>response.json({themes:await listThemes(response.locals.shop)})));
  router.post('/shopify/themes/:id/duplicate',handle(async(request,response)=>{const domain=response.locals.shop as string;const sourceId=String(request.params.id);const source=(await listThemes(domain)).find((item)=>item.id===sourceId);if(!source){response.status(404).json({error:'Theme not found.'});return;}const requested=typeof request.body?.name==='string'?request.body.name.trim():'';const name=requested||`${source.name} (Section OS draft)`;const theme=await themeDuplicate(domain,sourceId,name);response.status(201).json({theme});}));

  router.get('/projects',handle(async(_request,response)=>{const {record}=await shopContext(response);response.json({projects:await db.listProjects(record.id)});}));
  router.post('/projects',handle(async(request,response)=>{const {record}=await shopContext(response);const result=compileSection(request.body.manifest);if(!result.valid){response.status(422).json(result);return;}const project=await db.createProject(record.id,request.body.manifest);const version=await db.createVersion(project.id,request.body.manifest,result.files,sha256(JSON.stringify(request.body.manifest)));response.status(201).json({project,version});}));
  router.get('/projects/:id',handle(async(request,response)=>{const {record}=await shopContext(response);const project=await db.getProject(String(request.params.id),record.id);if(!project){response.status(404).json({error:'Project not found.'});return;}response.json({project,versions:await db.listVersions(project.id)});}));
  router.put('/projects/:id',handle(async(request,response)=>{const {record}=await shopContext(response);const result=compileSection(request.body.manifest);if(!result.valid){response.status(422).json(result);return;}const project=await db.updateProject(String(request.params.id),record.id,request.body.manifest);if(!project){response.status(404).json({error:'Project not found.'});return;}const version=await db.createVersion(project.id,request.body.manifest,result.files,sha256(JSON.stringify(request.body.manifest)));response.json({project,version});}));
  router.delete('/projects/:id',handle(async(request,response)=>{const {record}=await shopContext(response);response.status(await db.deleteProject(String(request.params.id),record.id)?204:404).end();}));
  router.get('/projects/:id/versions',handle(async(request,response)=>{const {record}=await shopContext(response);const project=await db.getProject(String(request.params.id),record.id);if(!project){response.status(404).json({error:'Project not found.'});return;}response.json({versions:await db.listVersions(project.id)});}));
  router.post('/projects/:id/versions/:versionId/restore',handle(async(request,response)=>{const {record}=await shopContext(response);const project=await db.getProject(String(request.params.id),record.id);if(!project){response.status(404).json({error:'Project not found.'});return;}const source=await db.getVersion(String(request.params.versionId),project.id);if(!source){response.status(404).json({error:'Version not found.'});return;}const result=compileSection(source.manifest);if(!result.valid){response.status(422).json(result);return;}const updated=await db.updateProject(project.id,record.id,source.manifest);const version=await db.createVersion(project.id,source.manifest,result.files,sha256(JSON.stringify(source.manifest)));await db.audit(record.id,'project.version_restored','merchant',{projectId:project.id,restoredFrom:source.id,versionId:version.id});response.status(201).json({project:updated??project,version,restoredFrom:source.version_number});}));
  router.post('/projects/:id/deploy',handle(async(request,response)=>{const {domain,record}=await shopContext(response);const project=await db.getProject(String(request.params.id),record.id);if(!project){response.status(404).json({error:'Project not found.'});return;}const result=compileSection(project.manifest);if(!result.valid){response.status(422).json(result);return;}const version=await db.createVersion(project.id,project.manifest,result.files,sha256(JSON.stringify(project.manifest)));response.json(await deployManifest(domain,record.id,project.manifest,request.body.themeId,project.id,version.id));}));

  router.post('/shopify/install',handle(async(request,response)=>{const {domain,record}=await shopContext(response);response.json(await deployManifest(domain,record.id,request.body.manifest,request.body.themeId));}));
  router.get('/deployments',handle(async(_request,response)=>{const {record}=await shopContext(response);const deployments=await db.listDeployments(record.id);response.json({deployments:deployments.map((item)=>({...item,snapshot:undefined}))});}));
  router.post('/deployments/:id/rollback',handle(async(request,response)=>{const {domain,record}=await shopContext(response);const deployment=await db.getDeployment(String(request.params.id),record.id);if(!deployment){response.status(404).json({error:'Deployment not found.'});return;}if(deployment.status!=='succeeded'){response.status(409).json({error:'Only successful, non-rolled-back deployments can be rolled back.'});return;}const theme=(await listThemes(domain)).find((item)=>item.id===deployment.theme_id);if(!theme||theme.role==='MAIN'){response.status(409).json({error:'Rollback is blocked because the target theme is missing or currently published.'});return;}const result=await rollbackFiles(domain,deployment.theme_id,deployment.snapshot as ThemeSnapshot[]);await db.markRolledBack(deployment.id);await db.audit(record.id,'deployment.rolled_back','merchant',{deploymentId:deployment.id});response.json(result);}));

  router.get('/api-keys',handle(async(_request,response)=>{const {record}=await shopContext(response);const keys=await db.listApiKeys(record.id);response.json({keys:keys.map(({secret_hash,...key})=>key)});}));
  router.post('/api-keys',handle(async(request,response)=>{const {record}=await shopContext(response);const secret=newSecret(30);const prefix=secret.slice(0,8);const token=`vso_live_${secret}`;const key=await db.createApiKey(record.id,String(request.body.label||'AI platform'),prefix,apiKeyHash(token));response.status(201).json({key:{id:key.id,label:key.label,key_prefix:key.key_prefix,created_at:key.created_at},token});}));
  router.delete('/api-keys/:id',handle(async(request,response)=>{const {record}=await shopContext(response);response.status(await db.revokeApiKey(String(request.params.id),record.id)?204:404).end();}));
  router.post('/api-keys/:id/rotate',handle(async(request,response)=>{const {record}=await shopContext(response);const existing=(await db.listApiKeys(record.id)).find((item)=>item.id===String(request.params.id)&&!item.revoked_at);if(!existing){response.status(404).json({error:'API key not found.'});return;}if(!await db.revokeApiKey(existing.id,record.id)){response.status(404).json({error:'API key not found.'});return;}const secret=newSecret(30);const prefix=secret.slice(0,8);const token=`vso_live_${secret}`;const key=await db.createApiKey(record.id,existing.label,prefix,apiKeyHash(token));await db.audit(record.id,'api_key.rotated','merchant',{previousKeyId:existing.id,keyId:key.id});response.status(201).json({key:{id:key.id,label:key.label,key_prefix:key.key_prefix,created_at:key.created_at},token});}));
  router.get('/billing',handle(async(_request,response)=>response.json(await getBillingStatus(response.locals.shop))));
  router.post('/billing/subscribe',handle(async(_request,response)=>response.json(await createSubscription(response.locals.shop))));
  return router;
}

export function createV1Router(){
  const router=Router();router.use(requireApiKey,rateLimit(120));
  router.get('/schema',(_request,response)=>response.json(contractJsonSchema()));
  router.post('/compile',(request,response)=>{const result=compileSection(request.body.manifest);response.status(result.valid?200:422).json(result);});
  router.get('/projects',handle(async(_request,response)=>response.json({projects:await db.listProjects(response.locals.shopId)})));
  router.post('/projects',handle(async(request,response)=>{const result=compileSection(request.body.manifest);if(!result.valid){response.status(422).json(result);return;}const project=await db.createProject(response.locals.shopId,request.body.manifest);const version=await db.createVersion(project.id,request.body.manifest,result.files,sha256(JSON.stringify(request.body.manifest)));response.status(201).json({project,version});}));
  return router;
}
