// lib/embeddingService.ts
import { pipeline, Pipeline } from '@xenova/transformers';

export class EmbeddingService {
  private static instance: EmbeddingService;
  private extractor: Pipeline | null = null;
  private modelName: string = 'Xenova/all-MiniLM-L6-v2'; // Or make configurable
  private loadingPromise: Promise<void> | null = null;

  private constructor() {
    // Private constructor for Singleton
    this.loadingPromise = this.loadModel();
  }

  public static async getInstance(): Promise<EmbeddingService> {
    if (!EmbeddingService.instance) {
      EmbeddingService.instance = new EmbeddingService();
      // Ensure model is loaded before instance is considered fully ready
      // No need to await here if constructor already awaits or if methods using extractor await
    }
    // Ensure model loading is complete before returning the instance
    await EmbeddingService.instance.loadingPromise;
    return EmbeddingService.instance;
  }

  private async loadModel(): Promise<void> {
    try {
      console.log(`Loading embedding model: ${this.modelName}`);
      this.extractor = await pipeline('feature-extraction', this.modelName, {
        quantized: true, // Use quantized model for efficiency if available
      });
      console.log('Embedding model loaded successfully.');
    } catch (error) {
      console.error('Failed to load embedding model:', error);
      throw error; // Re-throw to indicate failure
    }
  }

  public async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.extractor) {
      // Wait for loading to complete if it hasn't already
      await this.loadingPromise;
      if (!this.extractor) {
         console.error('Embedding model is not loaded.');
         return null;
      }
    }
    try {
      // The output structure might vary based on model/pipeline.
      // For sentence-transformers, it's often an array or a tensor that needs processing.
      // The `feature-extraction` pipeline output for sentence transformers is typically a tensor of shape [1, sequence_length, embedding_dim].
      // We need to pool this to get a single sentence embedding [embedding_dim].
      // For `all-MiniLM-L6-v2`, the output is directly the sentence embedding if the input text is a string.
      const result = await this.extractor(text, { pooling: 'mean', normalize: true });
      // result.data is a Float32Array. Convert to a regular array of numbers.
      return Array.from(result.data as Float32Array);
    } catch (error) {
      console.error('Failed to generate embedding:', error);
      return null;
    }
  }

  // Optional: A method to generate embeddings for multiple texts in batch
  public async generateEmbeddingsBatch(texts: string[]): Promise<Array<number[] | null>> {
    if (!this.extractor) {
      await this.loadingPromise;
       if (!this.extractor) {
         console.error('Embedding model is not loaded.');
         return texts.map(() => null);
      }
    }
    // Note: Batch processing might need specific handling with the Transformers.js library
    // For now, simple iteration, but can be optimized if the library supports batching directly for this task.
    const embeddings: Array<number[] | null> = [];
    for (const text of texts) {
      embeddings.push(await this.generateEmbedding(text));
    }
    return embeddings;
  }
}
