#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import "dotenv/config";

import {
  initializeLocalApi,
  searchLocalLibraries,
  fetchLocalLibraryDocumentation,
} from "./lib/api.js"; // MODIFIED: Using local API
import { formatSearchResults } from "./lib/utils.js";

// Initialize Local API with path from environment variable
const localDocsPath = process.env.LOCAL_DOCS_PATH;

if (!localDocsPath) {
  console.error(
    "FATAL: LOCAL_DOCS_PATH environment variable is not set. The server cannot operate without it."
  );
  process.exit(1); // Exit if critical env var is missing
}
initializeLocalApi(localDocsPath);

// Get DEFAULT_MAX_TOKENS from environment variable or use default
let DEFAULT_MAX_TOKENS = 5000; // This will now be a character limit
if (process.env.DEFAULT_MAX_TOKENS) {
  const parsedValue = parseInt(process.env.DEFAULT_MAX_TOKENS, 10);
  if (!isNaN(parsedValue) && parsedValue > 0) {
    DEFAULT_MAX_TOKENS = parsedValue;
  } else {
    console.warn(
      `Warning: Invalid DEFAULT_MAX_TOKENS value provided. Using default of ${DEFAULT_MAX_TOKENS} characters.`
    );
  }
}

const server = new McpServer({
  name: "seta",
  description:
    "Retrieves documentation and code examples for Salesforce development from local file system.", // MODIFIED
  version: "0.1.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Register tools
server.tool(
  "resolve-library-id",
  `Resolves library, framework, or technology names (like Apex, LWC, Visualforce, SOQL, DML, Triggers, Batch Apex, Asynchronous Apex, Salesforce APIs) into a unique local documentation ID. Use this tool first when you need up-to-date documentation, code examples, or best practices for Salesforce development tasks mentioned in the prompt. Provides a list of potential matches with descriptions and indicators like code snippet count or popularity.`,
  {
    libraryName: z
      .string()
      .describe("Library name to search for in local documentation."),
  },
  async ({ libraryName }) => {
    const searchResponse = await searchLocalLibraries(libraryName);

    if (!searchResponse || !searchResponse.results) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to search local libraries. Check server logs and LOCAL_DOCS_PATH.",
          },
        ],
      };
    }

    if (searchResponse.results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No local documentation libraries found matching '${libraryName}'.`,
          },
        ],
      };
    }

    const resultsText = formatSearchResults(searchResponse);

    return {
      content: [
        {
          type: "text",
          text: `Available Local Libraries (top matches):

Each result includes:
- Local Library ID: Directory name for use with 'get-library-docs'
- Name: Library name from manifest
- Description: Short summary from manifest
- Code Snippets (optional): Number of available code examples (from manifest)
- GitHub Stars (optional): Popularity indicator (from manifest)

For best results, select libraries based on name match and relevance to your use case.
Make sure your LOCAL_DOCS_PATH is set correctly and contains the library directories with manifest.json.

---

${resultsText}`,
        },
      ],
    };
  }
);

server.tool(
  "get-library-docs",
  "Fetches specific, up-to-date documentation, code examples, API details, and best practices for a given local library ID (obtained from 'resolve-library-id'). Use this tool *after* identifying the correct library ID to get detailed context for tasks like writing Apex classes, LWC components, SOQL queries, understanding governor limits, implementing triggers, or using specific Salesforce features. Can optionally focus on a specific 'topic' within the documentation (e.g., 'DML Operations', 'Batch Apex Limits').",
  {
    localLibraryID: z
      .string()
      .describe(
        "Exact local library ID (directory name, e.g., 'my-library') retrieved from 'resolve-library-id'."
      ),
    topic: z
      .string()
      .optional()
      .describe(
        "Topic to focus documentation on (maps to a file in the library's manifest.json)."
      ),
    keywords: z // NEW FIELD
      .string()
      .optional()
      .describe(
        "Keywords to search for within the document content (e.g., 'aura iteration'). If provided, 'topic' might be ignored. Results will be snippets containing these keywords."
      ),
    tokens: z
      .preprocess(
        (val) => (typeof val === "string" ? Number(val) : val),
        z.number()
      )
      .transform((val) => (val > DEFAULT_MAX_TOKENS ? DEFAULT_MAX_TOKENS : val))
      .optional()
      .describe(
        `Maximum number of characters (approx. tokens) of documentation to retrieve (default: ${DEFAULT_MAX_TOKENS}). Lower values provide less context.`
      ),
  },
  async ({ localLibraryID, tokens = DEFAULT_MAX_TOKENS, topic = "", keywords }) => { // Added 'keywords' here
    const documentationText = await fetchLocalLibraryDocumentation(
      localLibraryID,
      {
        tokens,
        topic,
        keywords, // Pass 'keywords' here
      }
    );

    if (!documentationText) {
      return {
        content: [
          {
            type: "text",
            text: `Documentation not found for local library ID '${localLibraryID}' (topic: '${topic || "default"}').
This might happen if:
1. The local library ID is incorrect (use 'resolve-library-id' first).
2. The library's manifest.json is missing, malformed, or doesn't define the topic/default document.
3. The document file itself is missing or unreadable.
4. LOCAL_DOCS_PATH is not configured correctly on the server.`, // MODIFIED error message
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: documentationText,
        },
      ],
    };
  }
);

async function main() {
  // LOCAL_DOCS_PATH check is now at the top
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`seta MCP Server running on stdio.`);
  console.error(`Reading documentation from: ${localDocsPath}`);
  console.error(`Default maximum characters for docs: ${DEFAULT_MAX_TOKENS}`);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
