import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSectionOsMcpServer } from '../server/mcp';
import { createCinematicHeroManifest } from '../src/compiler/cinematicHero';

describe('MCP platform connection', () => {
  it('advertises Section OS tools and compiles a valid contract', async () => {
    const server = createSectionOsMcpServer('mcp-test.myshopify.com', 'mcp-shop-id');
    const client = new Client({ name: 'section-os-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'validate_shopify_section', 'compile_shopify_section', 'list_section_projects', 'save_section_project', 'deploy_section_to_unpublished_theme',
    ]));
    const output = await client.callTool({ name: 'validate_shopify_section', arguments: { manifest: createCinematicHeroManifest() } });
    expect(output.isError).not.toBe(true);
    expect(JSON.stringify(output.structuredContent)).toContain('"valid":true');

    await client.close();
    await server.close();
  });
});
