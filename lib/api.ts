import fs from "fs/promises";
import path from "path";
import {
  LocalSearchResponse,
  LocalLibraryManifest,
  LocalSearchResultItem,
} from "./types.js";

let localDocsPath: string | undefined = process.env.LOCAL_DOCS_PATH;
export let documentContentIndex: Map<string, Map<string, string>> = new Map();

// Function to set or update the docs path, e.g., after dotenv.config()
export async function initializeLocalApi(docsPath?: string) {
  if (docsPath) {
    localDocsPath = docsPath;
  }
  if (!localDocsPath) {
    console.error(
      "LOCAL_DOCS_PATH environment variable is not set. Local documentation features will not work."
    );
    return; // Return early if path is not set
  }

  documentContentIndex.clear();

  try {
    const Direntsoriginal = await fs.readdir(localDocsPath, {
      withFileTypes: true,
    });
    const directories = Direntsoriginal.filter((dirent) =>
      dirent.isDirectory()
    );

    for (const dir of directories) {
      const manifestPath = path.join(localDocsPath, dir.name, "manifest.json");
      try {
        const manifestContent = await fs.readFile(manifestPath, "utf-8");
        const manifest: LocalLibraryManifest = JSON.parse(manifestContent);
        const libraryFilesContent: Map<string, string> = new Map();

        // Index default_doc
        if (manifest.default_doc) {
          const defaultDocPath = path.join(
            localDocsPath!,
            dir.name,
            manifest.default_doc
          );
          try {
            const content = await fs.readFile(defaultDocPath, "utf-8");
            libraryFilesContent.set(manifest.default_doc, content);
          } catch (err) {
            console.warn(`Could not read default_doc: ${defaultDocPath}`, err);
          }
        }

        // Index topics
        if (Array.isArray(manifest.topics)) {
          for (const topic of manifest.topics) {
            if (topic.file && typeof topic.file === "string") {
              const topicFilePath = path.join(
                localDocsPath!,
                dir.name,
                topic.file
              );
              try {
                const content = await fs.readFile(topicFilePath, "utf-8");
                libraryFilesContent.set(topic.file, content);
              } catch (err) {
                console.warn(`Could not read topic file: ${topicFilePath}`, err);
              }
            }
          }
        }

        if (libraryFilesContent.size > 0) {
          documentContentIndex.set(dir.name, libraryFilesContent);
        }
      } catch (err) {
        // Ignore directories without manifest.json or with malformed manifest
        console.warn(`Could not process manifest for ${dir.name}:`, err);
      }
    }
  } catch (error) {
    console.error("Error initializing local API and building index:", error);
  }
}

/**
 * Searches for local libraries matching the given query.
 * @param query The search query (matches against manifest name and description)
 * @returns Search results or null if the base path is not configured or an error occurs.
 */
export async function searchLocalLibraries(
  query: string
): Promise<LocalSearchResponse | null> {
  if (!localDocsPath) {
    console.error("LOCAL_DOCS_PATH is not configured.");
    return { results: [] };
  }

  try {
    const Direntsoriginal = await fs.readdir(localDocsPath, {
      withFileTypes: true,
    });
    const directories = Direntsoriginal.filter((dirent) =>
      dirent.isDirectory()
    );
    const results: LocalSearchResultItem[] = [];
    const lowerCaseQuery = query.toLowerCase();

    for (const dir of directories) {
      const manifestPath = path.join(localDocsPath, dir.name, "manifest.json");
      try {
        const manifestContent = await fs.readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(manifestContent);

        let topicMatch = false;
        if (Array.isArray(manifest.topics)) {
          for (const topic of manifest.topics as any[]) {
            if (
              (topic.name &&
                typeof topic.name === "string" &&
                topic.name.toLowerCase().includes(lowerCaseQuery)) ||
              (Array.isArray(topic.tags) &&
                (topic.tags as string[]).some((tag: string) =>
                  tag.toLowerCase().includes(lowerCaseQuery)
                ))
            ) {
              console.log("topicMatch", topic.name, topic.tags);
              topicMatch = true;
              break;
            }
          }
        }

        const nameMatch =
          manifest.name && manifest.name.toLowerCase().includes(lowerCaseQuery);
        const descriptionMatch =
          manifest.description &&
          manifest.description.toLowerCase().includes(lowerCaseQuery);

        if (nameMatch || descriptionMatch || topicMatch) {
          results.push({
            id: dir.name, // Use directory name as ID
            name: manifest.name,
            description: manifest.description,
            stars: manifest.stars ?? -1,
            totalSnippets: manifest.totalSnippets ?? -1,
          });
        } else {
          // If NO manifest match, check content index for this library
          const libraryId = dir.name;
          if (documentContentIndex.has(libraryId)) {
            const libraryFilesContent = documentContentIndex.get(libraryId)!;
            for (const fileContent of libraryFilesContent.values()) {
              if (fileContent.toLowerCase().includes(lowerCaseQuery)) {
                // Content match found
                results.push({
                  id: libraryId,
                  name: manifest.name || libraryId, // Use manifest data already loaded
                  description: manifest.description || "Documentation contains relevant keywords.", // More informative
                  stars: manifest.stars ?? -1,
                  totalSnippets: manifest.totalSnippets ?? -1,
                });
                break; // Found content match for this library, no need to check other files for it
              }
            }
          }
        }
      } catch (err) {
        // Ignore directories without manifest.json or with malformed manifest
        console.warn(`Could not process manifest for ${dir.name}:`, err);
      }
    }
    return { results };
  } catch (error) {
    console.error("Error searching local libraries:", error);
    return null; // Or return { results: [] } to indicate an error but conform to type
  }
}

/**
 * Fetches documentation content for a specific local library.
 * @param libraryId The library ID (directory name) to fetch documentation for.
 * @param options Options for the request, including topic, keywords, and character limit.
 * @returns The documentation text (possibly truncated) or null if not found or an error occurs.
 */
export async function fetchLocalLibraryDocumentation(
  libraryId: string,
  options: {
    topic?: string;
    keywords?: string;
    tokens?: number; // Character limit
  } = {}
): Promise<string | null> {
  if (!localDocsPath) {
    console.error("LOCAL_DOCS_PATH is not configured.");
    return null;
  }

  const manifestPath = path.join(localDocsPath, libraryId, "manifest.json");
  let manifest: LocalLibraryManifest;
  try {
    const manifestContent = await fs.readFile(manifestPath, "utf-8");
    manifest = JSON.parse(manifestContent);
  } catch (error) {
    console.error(`Error reading or parsing manifest for ${libraryId}:`, error);
    return `Error: Could not load manifest for library ${libraryId}.`;
  }

  let allContent: string[] = [];
  let combinedContent: string = "";

  // 1. Keyword Search
  if (options.keywords && options.keywords.trim() !== "") {
    const libraryIndexedFiles = documentContentIndex.get(libraryId);
    if (libraryIndexedFiles && libraryIndexedFiles.size > 0) {
      const searchKeywords = options.keywords.toLowerCase().split(/\s+/).filter(k => k);
      
      for (const [fileName, fileContent] of libraryIndexedFiles) {
        const paragraphs = fileContent.split(/\n\n+/); // Split by one or more newlines
        let fileSnippetsFound = false;
        for (const paragraph of paragraphs) {
          const lowerParagraph = paragraph.toLowerCase();
          if (searchKeywords.some(keyword => lowerParagraph.includes(keyword))) {
            if (!fileSnippetsFound) {
              // Add a header for the file if snippets are found in it
              allContent.push(`\n## Snippets from ${fileName}:\n`);
              fileSnippetsFound = true;
            }
            allContent.push(paragraph);
          }
        }
      }
    }
    if (allContent.length === 0) {
      return "No snippets found matching your keywords.";
    }
  }
  // 2. Topic Search (if no keywords or keyword search yielded no results and topic is present)
  else if (options.topic && Array.isArray(manifest.topics)) {
    const libraryContents = documentContentIndex.get(libraryId);
    if (!libraryContents) {
        console.warn(`No indexed content found for library ${libraryId} during topic search.`);
        // Proceed to default doc fallback
    } else {
        const searchTerm = options.topic.toLowerCase();
        let mainTopic = manifest.topics.find(
            (t: any) => t.name.toLowerCase() === searchTerm ||
                         (Array.isArray(t.tags) && t.tags.some((tag: string) => tag.toLowerCase() === searchTerm))
        );
        if (!mainTopic) {
            mainTopic = manifest.topics.find(
                (t: any) => t.name.toLowerCase().includes(searchTerm) ||
                             (Array.isArray(t.tags) && t.tags.some((tag: string) => tag.toLowerCase().includes(searchTerm) || searchTerm.includes(tag.toLowerCase())))
            );
        }

        if (mainTopic && typeof mainTopic.file === "string") {
            const docFileName = mainTopic.file;
            if (libraryContents.has(docFileName)) {
                const mainContent = libraryContents.get(docFileName)!;
                allContent.push(`# ${mainTopic.name.toUpperCase()}\n\n${mainContent}`);

                if (Array.isArray(mainTopic.related) && mainTopic.related.length > 0) {
                    for (const relatedName of mainTopic.related) {
                        const relatedTopic = manifest.topics.find((t: any) => t.name.toLowerCase() === relatedName.toLowerCase());
                        if (relatedTopic && typeof relatedTopic.file === "string") {
                            const relatedFile = relatedTopic.file;
                            if (libraryContents.has(relatedFile)) {
                                const relatedContent = libraryContents.get(relatedFile)!;
                                allContent.push(`\n\n# RELATED: ${relatedTopic.name.toUpperCase()}\n\n${relatedContent}`);
                            } else {
                                console.warn(`Could not find content for related topic file: ${relatedFile} in index for library ${libraryId}`);
                            }
                        }
                    }
                }
            } else {
                console.warn(`Could not find content for main topic file: ${docFileName} in index for library ${libraryId}`);
            }
        }
    }
  }

  // 3. Default/Fallback Document (if no keywords, and topic search yielded no content or no topic was specified)
  if (allContent.length === 0) {
    const libraryContents = documentContentIndex.get(libraryId);
    if (libraryContents && manifest.default_doc && libraryContents.has(manifest.default_doc)) {
      allContent.push(libraryContents.get(manifest.default_doc)!);
    } else if (libraryContents && libraryContents.size > 0) {
      // Fallback to the first indexed document for this library if default_doc is not available or not indexed
      const firstFileName = libraryContents.keys().next().value;
      if (firstFileName) {
        allContent.push(libraryContents.get(firstFileName)!);
         console.warn(`Using first indexed document: ${firstFileName} as fallback for library ${libraryId}`);
      }
    }
  }

  if (allContent.length === 0) {
    return `Documentation not found for library ${libraryId}. Check available topics or try different keywords.`;
  }

  combinedContent = allContent.join("\n\n");

  // 4. Smarter Truncation
  if (options.tokens && combinedContent.length > options.tokens) {
    let roughCut = combinedContent.substring(0, options.tokens);
    let lastSpace = roughCut.lastIndexOf(' ');

    // Ensure lastSpace is not too early (e.g., > 80% of tokens) and also not -1
    if (lastSpace > options.tokens * 0.8 && lastSpace !== -1) {
      combinedContent = roughCut.substring(0, lastSpace) + " [...]";
    } else {
      // If no good space found, or it's too early, just cut at tokens and add indicator
      combinedContent = roughCut + " [...]";
    }
  }

  return combinedContent;
}
