import type { Option } from 'commander';

/**
 * Modality descriptor: keeps the actual differences between modalities in one place.
 *
 *   1. Create/query endpoint paths (createPath / queryPath)
 *   2. Request options (genOptions + parseGenOptions + validateGen + buildCreateRequest)
 *   3. Artifact field names and shapes (extractArtifactUrls)
 *   4. Artifact extension inference strategy (resolveExtension)
 *
 * Shared layers (client HTTP/retry/envelope handling, poller, and download concurrency/failure summaries,
 * config, reporter, and exit-code semantics) do not know about modalities and must not branch by modality.
 * Adding a modality means adding a ModalitySpec implementation and registering it in MODALITIES without changing the skeleton.
 */

/** Artifact nouns for singular/plural output text, such as image/images or video/videos. */
export interface ArtifactNoun {
  singular: string;
  plural: string;
}

export interface ModalitySpec<GenOpts = unknown> {
  /** Modality name, also used as the command group name and in hints such as linkmodel <name> status. */
  readonly name: string;
  /** Command group description */
  readonly description: string;
  /** gen subcommand description */
  readonly genDescription: string;
  /** Create endpoint path, such as /image-generation */
  readonly createPath: string;
  /** Query endpoint path, such as /query/image-generation */
  readonly queryPath: string;
  readonly artifactNoun: ArtifactNoun;
  readonly defaultModelConfigKey?: 'default-image-model' | 'default-video-model';

  /** Modality-specific gen options; shared options such as --out, --json, and --timeout are registered by cli.ts. */
  readonly genOptions: readonly Option[];

  /**
   * Optional: return model-specific gen options for the current --model.
   * Avoid putting every option for every model into one help page.
   */
  genOptionsForModel?(model: string): readonly Option[];

  /** Parse Commander raw opts into modality-specific options. Commander has already applied defaults here. */
  parseGenOptions(raw: Record<string, unknown>): GenOpts;

  /** Local validation (exit 2). Return error messages; an empty array means valid. Obvious request errors are stopped here. */
  validateGen(prompt: string, opts: GenOpts): string[];

  /** Build the create endpoint request body. */
  buildCreateRequest(prompt: string, opts: GenOpts): Record<string, unknown>;

  /**
   * Extract artifact URLs from query response data, called for Success terminal state.
   * image reads output_images. Missing or invalid shapes return an empty array so the shared layer can report an explicit error.
   */
  extractArtifactUrls(data: Record<string, unknown>): string[];

  /** Artifact extension inference: Content-Type first, then URL path, then the modality fallback. */
  resolveExtension(url: string, contentType: string | null): string;
}

/** Return the artifact noun in singular or plural form. */
export function artifactNoun(spec: ModalitySpec, n: number): string {
  return n === 1 ? spec.artifactNoun.singular : spec.artifactNoun.plural;
}
