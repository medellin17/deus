import { readFile } from "fs/promises";

interface Chunk {
  heading: string;
  level: number;
  content: string;
  tokenCount: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitByHeaders(content: string): { heading: string; level: number; body: string }[] {
  const lines = content.split("\n");
  const sections: { heading: string; level: number; body: string }[] = [];
  let currentHeading = "";
  let currentLevel = 0;
  let currentBody: string[] = [];

  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      if (currentBody.length > 0 || currentHeading) {
        sections.push({
          heading: currentHeading,
          level: currentLevel,
          body: currentBody.join("\n").trim(),
        });
      }
      currentLevel = match[1].length;
      currentHeading = match[2].trim();
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  if (currentBody.length > 0 || currentHeading) {
    sections.push({
      heading: currentHeading,
      level: currentLevel,
      body: currentBody.join("\n").trim(),
    });
  }

  return sections;
}

function splitByParagraphs(text: string): string[] {
  return text.split(/\n\n+/).filter((p) => p.trim().length > 0);
}

function splitBySentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
}

function createChunk(heading: string, level: number, content: string): Chunk {
  return { heading, level, content: content.trim(), tokenCount: estimateTokens(content) };
}

function chunkSection(heading: string, level: number, body: string, maxTokens: number): Chunk[] {
  if (estimateTokens(body) <= maxTokens) {
    return body.trim() ? [createChunk(heading, level, body)] : [];
  }

  const paragraphs = splitByParagraphs(body);
  const chunks: Chunk[] = [];

  for (const para of paragraphs) {
    if (estimateTokens(para) <= maxTokens) {
      chunks.push(createChunk(heading, level, para));
    } else {
      const sentences = splitBySentences(para);
      let buffer = "";

      for (const sentence of sentences) {
        if (estimateTokens(buffer + " " + sentence) > maxTokens && buffer) {
          chunks.push(createChunk(heading, level, buffer));
          buffer = sentence;
        } else {
          buffer = buffer ? buffer + " " + sentence : sentence;
        }
      }

      if (buffer) {
        chunks.push(createChunk(heading, level, buffer));
      }
    }
  }

  return chunks;
}

function chunkMarkdown(content: string, maxTokens: number = 3000): Chunk[] {
  if (!content || content.trim().length === 0) {
    return [];
  }
  const sections = splitByHeaders(content);
  const chunks: Chunk[] = [];

  for (const section of sections) {
    chunks.push(...chunkSection(section.heading, section.level, section.body, maxTokens));
  }

  return chunks;
}

async function chunkFile(filePath: string): Promise<{ path: string; chunks: Chunk[] }> {
  const content = await readFile(filePath, "utf-8");
  return { path: filePath, chunks: chunkMarkdown(content) };
}

export { Chunk, chunkMarkdown, chunkFile, estimateTokens };
