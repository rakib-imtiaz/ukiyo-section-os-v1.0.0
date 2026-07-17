// Local MCP browser tools — LOCAL OPERATOR TOOL.
// Exposes the integrated browser (browserManager) as MCP tools over a localhost-only
// endpoint (POST /mcp-local). Because they drive the SAME singleton the live view streams
// from, anything Claude does here is visible in the Browser surface in real time. No API key
// (localhost-gated); disabled in production alongside config.browser.enabled.
import type { NextFunction, Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { config } from './config';
import { browserManager } from './browser';

function text(data: unknown) { return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }], structuredContent: (typeof data === 'object' && data ? data : { value: data }) as Record<string, unknown> }; }
function failure(error: unknown) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : 'Browser tool failed.' }] }; }

export function createBrowserMcpServer() {
  const server = new McpServer({ name: 'themebot-browser', version: '1.0.0' });

  server.registerTool('browser_status', {
    title: 'Browser status', description: 'Report the integrated browser engine, viewport, and current page.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => text(browserManager.status()));

  server.registerTool('browser_navigate', {
    title: 'Navigate', description: 'Navigate the integrated browser to a URL (opens the browser if not already running).',
    inputSchema: { url: z.string().describe('URL or search term to open') }, annotations: { openWorldHint: true },
  }, async ({ url }) => { try { return text(await browserManager.navigate(url)); } catch (error) { return failure(error); } });

  server.registerTool('browser_back', { title: 'Go back', description: 'Navigate back in history.', inputSchema: {}, annotations: { openWorldHint: true } }, async () => { await browserManager.goBack(); return text(browserManager.status().nav); });
  server.registerTool('browser_forward', { title: 'Go forward', description: 'Navigate forward in history.', inputSchema: {}, annotations: { openWorldHint: true } }, async () => { await browserManager.goForward(); return text(browserManager.status().nav); });
  server.registerTool('browser_reload', { title: 'Reload', description: 'Reload the current page.', inputSchema: {}, annotations: { openWorldHint: true } }, async () => { await browserManager.reload(); return text(browserManager.status().nav); });

  server.registerTool('browser_screenshot', {
    title: 'Screenshot', description: 'Capture a PNG screenshot of the current page.',
    inputSchema: { fullPage: z.boolean().optional().describe('Capture the full scrollable page instead of the viewport') }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ fullPage }) => {
    try { const buffer = await browserManager.screenshot(!!fullPage); return { content: [{ type: 'image' as const, data: buffer.toString('base64'), mimeType: 'image/png' }] }; }
    catch (error) { return failure(error); }
  });

  server.registerTool('browser_click', {
    title: 'Click', description: 'Click an element by CSS selector, or at viewport x/y coordinates.',
    inputSchema: { selector: z.string().optional().describe('CSS selector to click'), x: z.number().optional().describe('Viewport x'), y: z.number().optional().describe('Viewport y') }, annotations: { openWorldHint: true },
  }, async ({ selector, x, y }) => { try { await browserManager.click({ selector, x, y }); return text(browserManager.status().nav); } catch (error) { return failure(error); } });

  server.registerTool('browser_type', {
    title: 'Type text', description: 'Type text into an element (by selector) or at the current focus, optionally pressing Enter.',
    inputSchema: { selector: z.string().optional().describe('CSS selector of the field'), text: z.string().describe('Text to type'), submit: z.boolean().optional().describe('Press Enter afterwards') }, annotations: { openWorldHint: true },
  }, async ({ selector, text: value, submit }) => { try { await browserManager.typeText({ selector, text: value, submit }); return text(browserManager.status().nav); } catch (error) { return failure(error); } });

  server.registerTool('browser_read_page', {
    title: 'Read page', description: 'Return the current page URL, title, visible text, and links.', inputSchema: {}, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => { try { return text(await browserManager.readPage()); } catch (error) { return failure(error); } });

  server.registerTool('browser_evaluate', {
    title: 'Evaluate JavaScript', description: 'Evaluate a JavaScript expression in the page and return the result.',
    inputSchema: { expression: z.string().describe('JavaScript expression (evaluated in page context)') }, annotations: { openWorldHint: true },
  }, async ({ expression }) => { try { return text({ result: await browserManager.evaluate(expression) }); } catch (error) { return failure(error); } });

  server.registerTool('browser_console', {
    title: 'Console messages', description: 'Return recent console messages captured from the page.',
    inputSchema: { limit: z.number().optional().describe('Max messages (default 100)') }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => text({ console: browserManager.recentConsole(limit ?? 100) }));

  server.registerTool('browser_network', {
    title: 'Network activity', description: 'Return recent network responses/failures captured from the page.',
    inputSchema: { limit: z.number().optional().describe('Max entries (default 100)') }, annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ limit }) => text({ network: browserManager.recentNetwork(limit ?? 100) }));

  server.registerTool('browser_run_qa', {
    title: 'Run QA', description: 'Load a URL (and optionally a comparison URL) in the integrated browser and report load time, console errors, failed requests, and a screenshot.',
    inputSchema: { url: z.string().describe('Primary URL to QA'), compareUrl: z.string().optional().describe('Optional second URL to also capture') }, annotations: { openWorldHint: true },
  }, async ({ url, compareUrl }) => { try { return text(await browserManager.runQa({ url, compareUrl })); } catch (error) { return failure(error); } });

  return server;
}

/** Localhost + prod gate for the local MCP endpoint. */
export function requireLocalMcp(request: Request, response: Response, next: NextFunction) {
  if (!config.browser.enabled) { response.status(404).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Integrated browser is disabled.' }, id: null }); return; }
  const hostname = (value: string | undefined) => { if (!value) return null; try { return new URL(value.includes('://') ? value : `http://${value}`).hostname.toLowerCase(); } catch { return null; } };
  const loop = (name: string | null) => name === 'localhost' || name === '127.0.0.1' || name === '::1' || name === '[::1]';
  const ok = loop(hostname(request.headers.host)) && (request.headers.origin == null || loop(hostname(request.headers.origin as string)));
  if (!ok) { response.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Local MCP is available on localhost only.' }, id: null }); return; }
  next();
}

export async function handleLocalMcp(request: Request, response: Response, _next: NextFunction) {
  const server = createBrowserMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on('close', () => { void transport.close(); void server.close(); });
  } catch (error) {
    if (!response.headersSent) response.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error instanceof Error ? error.message : 'Internal server error' }, id: null });
  }
}
