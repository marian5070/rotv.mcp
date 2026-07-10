import { z } from 'zod';

export const ProgramInner = z
  .object({
    title: z.string(),
    start_local: z.string(),
    start_utc: z.string(),
    stop_local: z.string(),
    stop_utc: z.string(),
    duration_min: z.number(),
    category: z.string().nullable().optional(),
    description: z.string().optional(),
  })
  .passthrough();

export const ShapedProgram = z
  .object({
    channel_id: z.string(),
    channel_name: z.string(),
    channel_category: z.string().nullable().optional(),
    program: ProgramInner,
  })
  .passthrough();

export const WindowUtc = z
  .object({
    from_utc: z.string(),
    to_utc: z.string(),
  })
  .passthrough();

export const Freshness = z
  .object({
    epg_age_min: z.number().nullable().optional(),
    streaming_age_min: z.number().nullable().optional(),
    stale: z.boolean(),
  })
  .passthrough();

export const ExtractedGenre = z
  .object({
    genre: z.string(),
    confidence: z.number(),
    anchors: z.array(z.string()).optional(),
  })
  .passthrough();

export const StreamingXref = z
  .object({
    provider_id: z.number(),
    provider_name: z.string(),
    kind: z.string(),
    confidence: z.number().optional(),
    confidence_label: z.string().optional(),
    tier: z.string().nullable().optional(),
    tmdb_id: z.number().nullable().optional(),
    title: z.string().nullable().optional(),
    original_title: z.string().nullable().optional(),
    year: z.number().nullable().optional(),
    genres: z.array(z.string()).optional(),
    runtime: z.number().nullable().optional(),
    vote_average: z.number().nullable().optional(),
  })
  .passthrough();

export const Loose = z.object({}).passthrough();
