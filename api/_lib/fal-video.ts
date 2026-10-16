import { fal } from "@fal-ai/serverless-client";

const MODEL_ID = "fal-ai/kling-video/v1/image-to-video";
const DEFAULT_PROMPT = "happy cartoon character dancing, full body motion, high quality";

interface KlingVideoOutput {
  video?: { url?: string };
}

export async function generateVideoFromImage(
  imageUrl: string,
  promptStyle?: string
): Promise<string> {
  const apiKey = process.env.FAL_KEY;
  if (!apiKey) {
    throw new Error("FAL_KEY is not set in environment variables");
  }
  if (!imageUrl) {
    throw new Error("imageUrl is required");
  }

  fal.config({ credentials: apiKey });

  try {
    const result = (await fal.subscribe(MODEL_ID, {
      input: {
        image_url: imageUrl,
        prompt: promptStyle?.trim() || DEFAULT_PROMPT,
        aspect_ratio: "9:16",
        duration: "5",
      },
      logs: true,
    })) as KlingVideoOutput;

    const videoUrl = result?.video?.url;
    if (!videoUrl) {
      throw new Error("fal.ai response did not contain a video URL");
    }
    return videoUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[fal-video] generateVideoFromImage failed:", message);
    throw new Error(`Video generation failed: ${message}`);
  }
}
