#!/usr/bin/env node

import fs from "fs/promises";
import path from "path";
import { EmbeddingService } from "../lib/embeddingService.js"; // Adjust path as necessary
import { connect, Table } from "@lancedb/lancedb";
import { LocalLibraryManifest } from "../lib/types.js"; // Adjust path
import 'dotenv/config'; // For LOCAL_DOCS_PATH

// LanceDB Constants (can be shared or defined here)
const DB_URI = "data/lancedb"; // Relative to project root
const TABLE_NAME = "documents";
const DUMMY_TEXT_FOR_DIM_CHECK = "get embedding dimension";

async function main() {
  console.log("Starting dedicated indexing process...");

  const localDocsPath = process.env.LOCAL_DOCS_PATH;
  if (!localDocsPath) {
    console.error(
      "LOCAL_DOCS_PATH environment variable is not set. Indexing cannot proceed."
    );
    process.exit(1);
  }
  console.log(`Using LOCAL_DOCS_PATH: ${localDocsPath}`);

  let embeddingService: EmbeddingService;
  try {
    embeddingService = await EmbeddingService.getInstance();
  } catch (error) {
    console.error("Failed to initialize EmbeddingService. Indexing cannot proceed.", error);
    process.exit(1);
  }

  try {
    await fs.mkdir(DB_URI, { recursive: true });
    const db = await connect(DB_URI);
    let table: Table;

    try {
      await db.dropTable(TABLE_NAME);
      console.log(`Dropped existing table ${TABLE_NAME} (if it existed).`);
    } catch (err: any) {
      if (err.message && err.message.includes("Table not found")) {
        console.log(`Table ${TABLE_NAME} not found, no need to drop. Proceeding to create.`);
      } else {
        console.warn(`Could not drop table ${TABLE_NAME}, it might not exist or another error occurred:`, err.message);
      }
    }
    
    const dummyEmbedding = await embeddingService.generateEmbedding(DUMMY_TEXT_FOR_DIM_CHECK);
    if (!dummyEmbedding) {
        console.error("Could not generate dummy embedding to check dimension. Indexing cannot proceed.");
        process.exit(1);
    }
    const embeddingDim = dummyEmbedding.length;
    console.log(`Determined embedding dimension: ${embeddingDim}`);

    // Create table with initial data for schema inference, then delete it.
    const initialDataForSchema = [{
        vector: Array(embeddingDim).fill(0.0),
        text: "schema_initialization_string",
        libraryId: "schema_init_lib",
        filePath: "schema_init_file.md",
        chunkId: "schema_init_chunk_0"
    }];
    
    table = await db.createTable(TABLE_NAME, initialDataForSchema, { writeMode: 'overwrite' }); // Overwrite mode
    console.log(`Created new LanceDB table: ${TABLE_NAME}. Deleting initial schema data...`);
    await table.delete('libraryId = "schema_init_lib"');
    console.log("Initial schema data deleted. Starting full document indexing.");

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
            if (chunks.length === 0) {
              console.log(`No content chunks found in ${filePath}, skipping.`);
              continue;
            }

            console.log(`Generating embeddings for ${chunks.length} chunks from ${relativeFilePath} in library ${dir.name}...`);
            const embeddings = await embeddingService.generateEmbeddingsBatch(chunks);
            const dataToInsert = [];
            for (let i = 0; i < chunks.length; i++) {
              if (embeddings[i]) {
                dataToInsert.push({
                  vector: embeddings[i] as number[],
                  text: chunks[i],
                  libraryId: dir.name,
                  filePath: relativeFilePath,
                  chunkId: `${relativeFilePath}-${i}` // Unique chunkId
                });
              } else {
                console.warn(`Failed to generate embedding for chunk ${i} in ${filePath}`);
              }
            }

            if (dataToInsert.length > 0) {
              await table.add(dataToInsert);
              console.log(`Successfully indexed ${dataToInsert.length} chunks from ${relativeFilePath} in library ${dir.name}`);
            }
          } catch (fileReadErr) {
            console.warn(`Could not read or process file ${filePath}:`, fileReadErr);
          }
        }
      } catch (manifestErr) {
        console.warn(`Could not process manifest for ${dir.name}:`, manifestErr);
      }
    }
    console.log("Document indexing process complete.");

  } catch (error) {
    console.error("Fatal error during indexing process:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error in main execution:", error);
  process.exit(1);
});
