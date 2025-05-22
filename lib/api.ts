import fs from "fs/promises";
import path from "path";
import {
  LocalSearchResponse,
  LocalLibraryManifest,
  LocalSearchResultItem,
} from "./types.js";
import { EmbeddingService } from "./embeddingService.js"; // Adjusted path
import { connect, Table, DB } from "@lancedb/lancedb"; // Ensure DB is imported

// LanceDB Constants
const DB_URI = "data/lancedb"; // Relative to project root
const TABLE_NAME = "documents";
const DUMMY_TEXT_FOR_DIM_CHECK = "get embedding dimension"; // For embedding dimension check

// Define DEFAULT_MAX_TOKENS if not imported or set globally, for fetchLocalLibraryDocumentation
// In a real app, this might come from a config or main.ts environment setup.
// For this subtask, defining it here to make the function self-contained.
const DEFAULT_MAX_TOKENS = 5000; // Default character limit

let localDocsPath: string | undefined = process.env.LOCAL_DOCS_PATH;
let isLanceDbInitialized = false; // Flag to ensure DB init runs once
let dbInstance: DB; // To be set by initializeLocalApi

export async function ensureDbConnected(): Promise<DB> {
    if (!dbInstance) {
        // This is a fallback, initializeLocalApi should be the primary initializer
        console.warn("Attempting to connect to DB directly from search/fetch. Ensure initializeLocalApi runs first.");
        // Ensure DB_URI directory exists before attempting to connect, vital for fallback
        await fs.mkdir(DB_URI, { recursive: true });
        dbInstance = await connect(DB_URI);
    }
    return dbInstance;
}

// Function to set or update the docs path, e.g., after dotenv.config()
export async function initializeLocalApi(docsPath?: string) {
  if (isLanceDbInitialized) {
    console.log("LanceDB and EmbeddingService already initialized.");
    return;
  }

  if (docsPath) {
    localDocsPath = docsPath;
  }
  if (!localDocsPath) {
    console.error(
      "LOCAL_DOCS_PATH environment variable is not set. Local documentation features will not work."
    );
    process.exit(1); // Critical error
  }

  console.log("Initializing EmbeddingService and LanceDB...");

  let embeddingService: EmbeddingService;
  try {
    embeddingService = await EmbeddingService.getInstance();
  } catch (error) {
    console.error("Failed to initialize EmbeddingService. Server cannot start.", error);
    process.exit(1);
  }

  try {
    // Ensure DB_URI directory exists
    await fs.mkdir(DB_URI, { recursive: true });
    const db = await connect(DB_URI);
    dbInstance = db; // Assign to the module-level variable
    let table: Table;

    try {
      table = await dbInstance.openTable(TABLE_NAME); // Use dbInstance
      console.log(`Opened existing LanceDB table: ${TABLE_NAME}`);
      // If table exists, we assume it's populated. No re-indexing here.
      // The CLI script will handle forced re-indexing.
    } catch (e) {
      console.log(`Table ${TABLE_NAME} not found, creating and indexing new one.`);

      const dummyEmbedding = await embeddingService.generateEmbedding(DUMMY_TEXT_FOR_DIM_CHECK);
      if (!dummyEmbedding) {
          console.error("Could not generate dummy embedding to check dimension. Server cannot start.");
          process.exit(1);
      }
      const embeddingDim = dummyEmbedding.length;
      console.log(`Determined embedding dimension: ${embeddingDim}`);
      
      // Create table with initial data for schema inference (LanceDB JS requirement)
      // This initial data will be deleted immediately after.
      const initialDataForSchema = [{
          vector: Array(embeddingDim).fill(0.0), // Float32Vector
          text: "schema_initialization_string",
          libraryId: "schema_init_lib",
          filePath: "schema_init_file.md",
          chunkId: "schema_init_chunk_0"
      }];
      
      table = await dbInstance.createTable(TABLE_NAME, initialDataForSchema); // Use dbInstance
      console.log(`Created LanceDB table: ${TABLE_NAME}. Deleting initial schema data...`);
      await table.delete('libraryId = "schema_init_lib"'); // Remove the dummy data
      console.log("Initial schema data deleted.");


      // Proceed with indexing all documents since table was just created
      const Direntsoriginal = await fs.readdir(localDocsPath, { withFileTypes: true });
      const directories = Direntsoriginal.filter((dirent) => dirent.isDirectory());

      for (const dir of directories) {
        const manifestPath = path.join(localDocsPath, dir.name, "manifest.json");
        try {
          const manifestContent = await fs.readFile(manifestPath, "utf-8");
          const manifest: LocalLibraryManifest = JSON.parse(manifestContent);
          const filesToIndex: { filePath: string; relativeFilePath: string }[] = [];

          if (manifest.default_doc) {
            filesToIndex.push({
              filePath: path.join(localDocsPath, dir.name, manifest.default_doc),
              relativeFilePath: manifest.default_doc,
            });
          }
          if (Array.isArray(manifest.topics)) {
            for (const topic of manifest.topics) {
              if (topic.file && typeof topic.file === "string") {
                filesToIndex.push({
                  filePath: path.join(localDocsPath, dir.name, topic.file),
                  relativeFilePath: topic.file,
                });
              }
            }
          }

          for (const { filePath, relativeFilePath } of filesToIndex) {
            try {
              const content = await fs.readFile(filePath, "utf-8");
              const chunks = content.split(/\n\n+/g).filter(chunk => chunk.trim() !== '');
              if (chunks.length === 0) continue;

              console.log(`Generating embeddings for ${chunks.length} chunks from ${filePath}...`);
              const embeddings = await embeddingService.generateEmbeddingsBatch(chunks);
              const dataToInsert = [];
              for (let i = 0; i < chunks.length; i++) {
                if (embeddings[i]) {
                  dataToInsert.push({
                    vector: embeddings[i] as number[],
                    text: chunks[i],
                    libraryId: dir.name,
                    filePath: relativeFilePath,
                    chunkId: `${relativeFilePath}-${i}`
                  });
                } else {
                  console.warn(`Failed to generate embedding for chunk ${i} in ${filePath}`);
                }
              }

              if (dataToInsert.length > 0) {
                await table.add(dataToInsert);
                console.log(`Indexed ${dataToInsert.length} chunks from ${filePath}`);
              }
            } catch (fileReadErr) {
              console.warn(`Could not read or process file ${filePath}:`, fileReadErr);
            }
          }
        } catch (manifestErr) {
          console.warn(`Could not process manifest for ${dir.name}:`, manifestErr);
        }
      }
      console.log("Initial indexing complete.");
    }
    isLanceDbInitialized = true; // Set flag after successful initialization
  } catch (error) {
    console.error("Error initializing LanceDB:", error);
    process.exit(1); // Critical error
  }
}


/**
 * Searches for local libraries matching the given query. (Content search to be updated for LanceDB)
 * @param query The search query (matches against manifest name, description, AND indexed content)
 * @returns Search results or null if the base path is not configured or an error occurs.
 */
export async function searchLocalLibraries(
  query: string
): Promise<LocalSearchResponse | null> {
  if (!localDocsPath) { 
    console.error("LOCAL_DOCS_PATH is not configured.");
    return { results: [] };
  }
  if (!isLanceDbInitialized) {
      console.error("LanceDB is not initialized. Call initializeLocalApi first.");
      return { results: [{id: "LANCEDB_INIT_ERROR", name: "Database not initialized", description: "Please wait for DB initialization or check server logs."}] };
  }

  try {
      const embeddingService = await EmbeddingService.getInstance();
      const db = await ensureDbConnected(); // Use shared or re-connect
      let table: Table;
      try {
        table = await db.openTable(TABLE_NAME);
      } catch (err: any) {
        if (err.message && err.message.includes("Table not found")) {
            console.warn(`LanceDB table ${TABLE_NAME} not found. Please run the indexing script first ('npm run index-docs').`);
            return { results: [{id: "INDEXING_ERROR", name: "Database not indexed", description: "Please run the indexing script ('npm run index-docs')."}] };
        }
        throw err; // Re-throw other errors
      }


      // 1. Generate query embedding
      const queryEmbedding = await embeddingService.generateEmbedding(query);
      if (!queryEmbedding) {
          console.error("Failed to generate query embedding.");
          return { results: [] };
      }

      // 2. Query LanceDB
      const limit = 25; // How many top chunks to retrieve
      const searchResults = await table
          .search(queryEmbedding)
          .limit(limit)
          .execute(); 

      if (!searchResults || searchResults.length === 0) {
          return { results: [] };
      }

      // 3. Aggregate results to determine relevant libraries
      const libraryScores: Map<string, { score: number, count: number, uniqueDocs: Set<string> }> = new Map();

      for (const result of searchResults) {
          const libId = result.libraryId as string;
          const filePath = result.filePath as string;
          const scoreForResult = (result._score || 0); 

          if (!libraryScores.has(libId)) {
              libraryScores.set(libId, { score: 0, count: 0, uniqueDocs: new Set() });
          }
          const currentEntry = libraryScores.get(libId)!;
          currentEntry.score += scoreForResult;
          currentEntry.count++;
          currentEntry.uniqueDocs.add(filePath);
      }

      // Convert map to array and sort
      const rankedLibraries = Array.from(libraryScores.entries())
          .map(([id, data]) => ({
              id,
              totalScore: data.score,
              chunkCount: data.count,
              documentCount: data.uniqueDocs.size,
              relevance: (data.score / data.count) * (1 + Math.log1p(data.uniqueDocs.size)) 
          }))
          .sort((a, b) => b.relevance - a.relevance); 

      // 4. Format for LocalSearchResponse
      const topNResults = 5; 
      const finalResults: LocalSearchResultItem[] = [];

      for (let i = 0; i < Math.min(rankedLibraries.length, topNResults); i++) {
          const libInfo = rankedLibraries[i];
          const manifestPath = path.join(localDocsPath, libInfo.id, "manifest.json");
          try {
              const manifestContent = await fs.readFile(manifestPath, "utf-8");
              const manifest: LocalLibraryManifest = JSON.parse(manifestContent);
              finalResults.push({
                  id: libInfo.id,
                  name: manifest.name,
                  description: manifest.description || `Relevant content found with score: ${libInfo.relevance.toFixed(2)}`,
                  stars: manifest.stars ?? -1,
                  totalSnippets: manifest.totalSnippets ?? -1,
              });
          } catch (err) {
              console.warn(`Could not read manifest for library ${libInfo.id}:`, err);
              finalResults.push({
                  id: libInfo.id,
                  name: libInfo.id, 
                  description: `Relevant content found (manifest missing). Score: ${libInfo.relevance.toFixed(2)}`,
              });
          }
      }
      return { results: finalResults };

  } catch (error: any) {
      console.error("Error during semantic library search:", error);
      if (error.message && error.message.includes("Table not found")) { // Double check, though inner try-catch should handle
           console.warn(`LanceDB table ${TABLE_NAME} not found. Please run the indexing script first ('npm run index-docs').`);
           return { results: [{id: "INDEXING_ERROR", name: "Database not indexed", description: "Please run the indexing script ('npm run index-docs')."}] };
      }
      return null; 
  }
}

/**
 * Fetches documentation content for a specific local library.
 * @param libraryId The library ID (directory name) to fetch documentation for.
 * @param options Options for the request, including topic (semantic query) and token limit. Keywords are ignored.
 * @returns The documentation text (possibly truncated) or null if not found or an error occurs.
 */
export async function fetchLocalLibraryDocumentation(
  libraryId: string,
  options: {
    topic?: string; // Semantic query
    tokens?: number;
    keywords?: string; // This will be ignored
  } = {}
): Promise<string | null> {
  if (!localDocsPath) {
    console.error("LOCAL_DOCS_PATH is not configured.");
    return null;
  }
  if (!isLanceDbInitialized) {
      console.error("LanceDB is not initialized. Call initializeLocalApi first for fetchLocalLibraryDocumentation.");
      // Consider returning a specific message or null, depending on desired UX for uninitialized DB
      return "Documentation system is not yet initialized. Please try again shortly.";
  }

  const { topic: queryText, tokens = DEFAULT_MAX_TOKENS } = options;

  try {
    const db = await ensureDbConnected(); // Ensures dbInstance is set
    const table = await db.openTable(TABLE_NAME);

    if (!queryText || queryText.trim() === "") {
      // No specific query, try to return default_doc content
      const manifestPath = path.join(localDocsPath, libraryId, "manifest.json");
      try {
        const manifestContent = await fs.readFile(manifestPath, "utf-8");
        const manifest: LocalLibraryManifest = JSON.parse(manifestContent);

        if (manifest.default_doc) {
          // Query LanceDB for all chunks for this specific file, ordering them
          const defaultDocChunks = await table.search() // This is not a vector search
            .where(`libraryId = '${libraryId}' AND filePath = '${manifest.default_doc}'`)
            .select(['text', 'chunkId', 'filePath']) // Ensure filePath is selected for robust chunkId parsing
            .execute();

          if (defaultDocChunks.length > 0) {
            // Sort chunks based on the index in chunkId (e.g., "filename.md-0", "filename.md-1")
            defaultDocChunks.sort((a, b) => {
              const aIndex = parseInt( (a.chunkId as string).substring((a.filePath as string).length + 1) || "0" );
              const bIndex = parseInt( (b.chunkId as string).substring((b.filePath as string).length + 1) || "0" );
              return aIndex - bIndex;
            });
            
            let combinedContent = defaultDocChunks.map(chunk => chunk.text).join("\n\n"); // Join with double newline

            if (tokens && combinedContent.length > tokens) {
              let roughCut = combinedContent.substring(0, tokens);
              let lastSpace = roughCut.lastIndexOf(' ');
              // Ensure lastSpace is valid and not too early (e.g. >80% of token limit)
              if (lastSpace > 0 && lastSpace > tokens * 0.8) { 
                combinedContent = roughCut.substring(0, lastSpace) + " [...]";
              } else {
                combinedContent = roughCut + " [...]";
              }
            }
            return combinedContent;
          } else {
            return `Default document '${manifest.default_doc}' for library '${libraryId}' was not found in the index. Consider re-indexing.`;
          }
        } else {
          return `Please provide a query (using the 'topic' parameter) to search within library '${libraryId}', or configure a 'default_doc' for it.`;
        }
      } catch (err: any) {
        console.warn(`Error accessing manifest or default_doc for ${libraryId}:`, err.message);
        return `Could not load default information for library '${libraryId}'. Please provide a specific query.`;
      }
    }

    // Semantic search part for when queryText (options.topic) is provided
    const embeddingService = await EmbeddingService.getInstance();
    const queryEmbedding = await embeddingService.generateEmbedding(queryText);

    if (!queryEmbedding) {
      console.error("Failed to generate query embedding for: " + queryText);
      return "Could not process your query. Please try again.";
    }

    const limit = 10; // Number of relevant chunks to retrieve for semantic search
    const searchResults = await table
      .search(queryEmbedding)
      .where(`libraryId = '${libraryId}'`) // Filter by the specific library
      .limit(limit)
      .execute();

    if (!searchResults || searchResults.length === 0) {
      return `No specific information found for '${queryText}' in library '${libraryId}'. Try a different query or check spelling.`;
    }

    // Concatenate text from relevant chunks, perhaps with a separator
    let combinedContent = searchResults
      .map(chunk => (chunk.text as string))
      .join("\n\n---\n\n"); // Separator for distinct chunks

    // Apply truncation
    if (tokens && combinedContent.length > tokens) {
      let roughCut = combinedContent.substring(0, tokens);
      let lastSpace = roughCut.lastIndexOf(' ');
      if (lastSpace > 0 && lastSpace > tokens * 0.8) { 
        combinedContent = roughCut.substring(0, lastSpace) + " [...]";
      } else {
        combinedContent = roughCut + " [...]";
      }
    }
    return combinedContent;

  } catch (error: any) {
    console.error(`Error in fetchLocalLibraryDocumentation for ${libraryId} with query "${queryText}":`, error.message);
    if (error.message && error.message.includes("Table") && error.message.includes("not found")) {
        return "Documentation database not indexed or table is missing. Please run the indexing script ('npm run index-docs').";
    }
    return "Failed to retrieve documentation due to a server error.";
  }
}
