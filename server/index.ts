import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import archiver from 'archiver';
import { compileSection } from '../src/compiler/compile';
import { createCinematicHeroManifest, defaultHeroState } from '../src/compiler/cinematicHero';
import { createApiRouter, createV1Router, requireApiKey } from './api';
import { beginShopifyAuth, completeShopifyAuth } from './auth';
import { config, validateProductionConfig } from './config';
import { db, flushFactoryState } from './db';
import { createFactoryRouter } from './factory/routes';
import { ensureWorkspaceRoot } from './factory/scaffolder';
import { factoryScheduler } from './factory/scheduler';
import { handleMcp, rejectMcpMethod } from './mcp';
import { handleLocalMcp, requireLocalMcp } from './browser-mcp';
import { createOnboardingRouter } from './onboarding-routes';
import { currentShop, normalizeShop, verifyWebhook } from './security';
import { storeTokens } from './shopify';
import { attachTerminal } from './terminal';
import { attachBrowser } from './browser';
import { installWsHub } from './ws-hub';

validateProductionConfig();
await db.init();

if(config.shopify.legacyShop&&config.shopify.legacyToken){
  const legacy=normalizeShop(config.shopify.legacyShop);
  if(legacy&&!(await db.getShop(legacy)))await storeTokens(legacy,{access_token:config.shopify.legacyToken,scope:config.shopify.scopes});
}

const app=express();
const __dirname=path.dirname(fileURLToPath(import.meta.url));
app.disable('x-powered-by');
app.set('trust proxy',1);

app.use((_request,response,next)=>{
  response.setHeader('X-Content-Type-Options','nosniff');
  response.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  response.setHeader('X-Frame-Options','DENY');
  response.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.myshopify.com");
  next();
});

app.post('/webhooks/app-uninstalled',express.raw({type:'application/json',limit:'1mb'}),async(request,response)=>{
  const body=request.body as Buffer;if(!verifyWebhook(body,request.header('x-shopify-hmac-sha256')??undefined)){response.status(401).end();return;}
  const shop=normalizeShop(request.header('x-shopify-shop-domain'));if(shop)await db.markUninstalled(shop);response.status(200).end();
});
app.post('/webhooks/compliance',express.raw({type:'application/json',limit:'1mb'}),async(request,response)=>{
  const body=request.body as Buffer;if(!verifyWebhook(body,request.header('x-shopify-hmac-sha256')??undefined)){response.status(401).end();return;}
  const shop=normalizeShop(request.header('x-shopify-shop-domain'));const topic=request.header('x-shopify-topic')??'unknown';
  if(shop&&topic==='shop/redact')await db.purgeShop(shop);else if(shop){const record=await db.getShop(shop);await db.audit(record?.id??null,`compliance.${topic}`,'shopify',{});}response.status(200).end();
});

app.use(express.json({limit:'3mb'}));
app.get('/auth/shopify',beginShopifyAuth);
app.get('/auth/shopify/callback',completeShopifyAuth);
app.post('/auth/logout',(request,response)=>{response.clearCookie('vso_session',{path:'/'});response.status(204).end();});

app.get('/api/health',(_request,response)=>response.json({ok:true,name:'ThemeBot',version:'1.0.0',database:db.persistent?'postgres':'memory',uptimeSec:Math.round(process.uptime())}));
app.get('/api/presets/cinematic-hero',(_request,response)=>response.json({state:defaultHeroState,manifest:createCinematicHeroManifest()}));
app.post('/api/compile',(request,response)=>{
  if(config.production&&!currentShop(request)){response.status(401).json({error:'Connect a Shopify store to compile sections.'});return;}
  const result=compileSection(request.body.manifest);response.status(result.valid?200:422).json(result);
});
app.post('/api/export',(request,response)=>{
  if(config.production&&!currentShop(request)){response.status(401).json({error:'Connect a Shopify store to export sections.'});return;}
  const result=compileSection(request.body.manifest);if(!result.valid){response.status(422).json(result);return;}
  response.attachment(`${request.body.manifest.handle}.zip`);const archive=archiver('zip',{zlib:{level:9}});archive.on('error',(error)=>response.destroy(error));archive.pipe(response);result.files.forEach((file)=>archive.append(file.content,{name:file.path}));void archive.finalize();
});
app.use('/api',createOnboardingRouter()); // claude/workspace/onboarding — localhost-only, before the session-gated router
app.use('/api/factory',createFactoryRouter());
app.use('/api',createApiRouter());
app.use('/v1',createV1Router());
app.post('/mcp',requireApiKey,handleMcp);
app.get('/mcp',rejectMcpMethod);app.delete('/mcp',rejectMcpMethod);
// Local MCP browser tools — localhost-only, no API key (see browser-mcp.ts).
app.post('/mcp-local',requireLocalMcp,handleLocalMcp);
app.get('/mcp-local',rejectMcpMethod);app.delete('/mcp-local',rejectMcpMethod);

if(process.env.NODE_ENV==='production'){
  const dist=path.resolve(__dirname,'../dist');app.use(express.static(dist,{maxAge:'1h',etag:true}));app.use((_request,response)=>response.sendFile(path.join(dist,'index.html')));
}

app.use((error:unknown,_request:express.Request,response:express.Response,_next:express.NextFunction)=>{
  const message=error instanceof Error?error.message:'Unexpected server error.';if(!config.production)console.error(error);response.status(500).json({error:config.production?'The request could not be completed.':message});
});

if(config.factory.enabled){await ensureWorkspaceRoot();await factoryScheduler.boot();}

const server=app.listen(config.port,()=>console.log(`ThemeBot listening on ${config.appUrl}`));
attachTerminal();
attachBrowser();
installWsHub(server);
const shutdown=async()=>{server.close();if(config.factory.enabled){await factoryScheduler.shutdown();flushFactoryState();}await db.close();process.exit(0);};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
