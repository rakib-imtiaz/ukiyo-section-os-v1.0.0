import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { config } from './config';
import { db } from './db';
import { createSubscription, getBillingStatus } from './billing';
import { shopifyGraphql, shopifyStatus } from './shopify';
import { currentShop, requireSession } from './security';
import { getClaudeStatusQuick } from './claude-connect';
import { getWorkspaceState } from './workspace';
import { cloudStatus } from './cloud-client';

type AsyncHandler = (request:Request,response:Response,next:NextFunction)=>Promise<unknown>;
const handle=(handler:AsyncHandler)=>(request:Request,response:Response,next:NextFunction)=>handler(request,response,next).catch(next);

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
    // cloud: the ThemeBot account, for desktop builds that require sign-in ({required:false} otherwise).
    response.json({authenticated:Boolean(record),shop:domain,persistent:db.persistent,shopify:shopifyStatus(),billing,claude,workspace,edition:config.edition,desktop:config.desktop,cloud:cloudStatus()});
  }));
  router.get('/shopify/status',(_request,response)=>response.json(shopifyStatus()));
  router.use(requireSession);
  // Live connection test: mints/refreshes the access token and round-trips the Admin API.
  // Returns granted scopes + token expiry; never echoes tokens or ciphers.
  router.get('/shopify/test',handle(async(_request,response)=>{
    const {domain}=await shopContext(response);
    try{
      const data=await shopifyGraphql<{shop:{name:string};currentAppInstallation:{accessScopes:Array<{handle:string}>}|null}>(domain,`#graphql
        query SectionOsConnectionTest { shop { name } currentAppInstallation { accessScopes { handle } } }`);
      const fresh=await db.getShop(domain); // re-read: the call above may have refreshed the token
      const scopes=data.currentAppInstallation?.accessScopes.map((scope)=>scope.handle)
        ??(fresh?.scopes?fresh.scopes.split(',').map((scope)=>scope.trim()).filter(Boolean):[]);
      response.json({ok:true,shop:domain,shopName:data.shop.name,scopes,expiresAt:fresh?.token_expires_at??null});
    }catch(error){
      response.status(502).json({ok:false,error:error instanceof Error?error.message:'Shopify connection test failed.',code:'SHOPIFY_TEST_FAILED'});
    }
  }));

  // Project listing: factory clone jobs surfaced as projects (kind 'clone'; shopless rows every
  // session sees) plus any legacy section rows still in the database. Read-only — the legacy
  // section-builder CRUD surface has been removed.
  router.get('/projects',handle(async(request,response)=>{const {record}=await shopContext(response);const includeClones=String(request.query.include??'clones')!=='sections';response.json({projects:await db.listProjects(record.id,{includeClones})});}));

  router.get('/billing',handle(async(_request,response)=>response.json(await getBillingStatus(response.locals.shop))));
  router.post('/billing/subscribe',handle(async(_request,response)=>response.json(await createSubscription(response.locals.shop))));
  return router;
}
