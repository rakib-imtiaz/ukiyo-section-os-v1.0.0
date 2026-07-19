import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApiRouter } from './api';
import { beginShopifyAuth, completeShopifyAuth } from './auth';
import { config, validateProductionConfig } from './config';
import { db, flushFactoryState } from './db';
import { createFactoryRouter } from './factory/routes';
import { ensureWorkspaceRoot } from './factory/scaffolder';
import { factoryScheduler } from './factory/scheduler';
import { handleLocalMcp, requireLocalMcp } from './browser-mcp';
import { createOnboardingRouter } from './onboarding-routes';
import { normalizeShop, verifyWebhook } from './security';
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
app.use('/api',createOnboardingRouter()); // claude/workspace/onboarding — localhost-only, before the session-gated router
app.use('/api/factory',createFactoryRouter());
app.use('/api',createApiRouter());
// Local MCP browser tools — localhost-only, no API key (see browser-mcp.ts).
const rejectMcpMethod=(_request:express.Request,response:express.Response)=>{response.status(405).json({jsonrpc:'2.0',error:{code:-32000,message:'Method not allowed.'},id:null});};
app.post('/mcp-local',requireLocalMcp,handleLocalMcp);
app.get('/mcp-local',rejectMcpMethod);app.delete('/mcp-local',rejectMcpMethod);

if(process.env.NODE_ENV==='production'){
  const dist=path.resolve(__dirname,'../dist');app.use(express.static(dist,{maxAge:'1h',etag:true}));app.use((_request,response)=>response.sendFile(path.join(dist,'index.html')));
}

app.use((error:unknown,_request:express.Request,response:express.Response,_next:express.NextFunction)=>{
  const message=error instanceof Error?error.message:'Unexpected server error.';if(!config.production)console.error(error);response.status(500).json({error:config.production?'The request could not be completed.':message});
});

if(config.factory.enabled){await ensureWorkspaceRoot();await factoryScheduler.boot();}

const server=app.listen(config.port,config.host,()=>console.log(`ThemeBot listening on ${config.appUrl} (bound to ${config.host}:${config.port})`));
attachTerminal();
attachBrowser();
installWsHub(server);
const shutdown=async()=>{server.close();if(config.factory.enabled){await factoryScheduler.shutdown();flushFactoryState();}await db.close();process.exit(0);};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
