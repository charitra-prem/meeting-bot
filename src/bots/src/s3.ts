import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readFileSync, promises as fsPromises, watch } from "fs";
import { Bot } from "./bot";
import { randomUUID } from "crypto";
import * as path from "path";

/**
 * Creates an S3 Connection to the bucket.
 * 
 * @returns S3Client
 */
export function createS3Client(region: string | undefined, accessKeyId: string | undefined, secretKey: string | undefined): S3Client|null {

    try {

        if (!region)
            throw new Error("Region is required");

        // Create an S3 client with credentials if they are provided
        // Local Development requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
        if (accessKeyId && secretKey) {
            return new S3Client({
                region,
                credentials: {
                    accessKeyId: accessKeyId,
                    secretAccessKey: secretKey!,
                },
            });

            // Production
            // Credientials is not required on AWS, so we can use the default constructor.
        } else {
            return new S3Client({
                region,
            });
        }

    } catch (error) {
        return null;
    }
}

/**
 * 
 * @param s3Client 
 * @param filePath 
 */
export async function uploadRecordingToS3(s3Client: S3Client, bot: Bot): Promise<string> {

    // Attempt to read the file path. Allow for time for the file to become available.
    const filePath = bot.getRecordingPath();
    let fileContent: Buffer;
    let i = 10;

    while (true) {
        try {

            fileContent = readFileSync(filePath);
            console.log("Successfully read recording file");
            break; // Exit loop if readFileSync is successful

        } catch (error) {
            const err = error as NodeJS.ErrnoException;

            // Could not read file.

            // Busy File
            if (err.code === "EBUSY") {
                console.log("File is busy, retrying...");
                await new Promise(r => setTimeout(r, 1000)); // Wait for 1 second before retrying

                // File DNE
            } else if (err.code === "ENOENT") {

                // Throw an Error
                if (i < 0)
                    throw new Error("File not found after multiple retries");

                console.log("File not found, retrying ", i--, " more times");
                await new Promise(r => setTimeout(r, 1000)); // Wait for 1 second before retrying

                // Other Error
            } else {
                throw error; // Rethrow if it's a different error
            }
        }
    }

    // Create UUID and initialize key
    const uuid = randomUUID();
    const contentType = bot.getContentType();
    const key = `recordings/${uuid}-${bot.settings.meetingInfo.platform
        }-recording.${contentType.split("/")[1]}`;

    try {
        const commandObjects = {
            Bucket: process.env.AWS_BUCKET_NAME!,
            Key: key,
            Body: fileContent,
            ContentType: contentType,
        };

        const putCommand = new PutObjectCommand(commandObjects);
        await s3Client.send(putCommand);
        console.log(`Successfully uploaded recording to S3: ${key}`);

        // Clean up local file
        await fsPromises.unlink(filePath);

        // Return the Upload Key
        return key;

    } catch (error) {
        console.error("Error uploading to S3:", error);
    }

    // No Upload
    return '';
}

/**
 * Watch for new recording segments and upload them to S3 as they're created
 *
 * @param s3Client - S3 client instance
 * @param segmentDir - Directory where segments are being written
 * @param botId - Bot ID for organizing S3 keys
 * @param onSegmentUploaded - Callback when a segment is uploaded
 * @returns Cleanup function to stop watching
 */
export function watchAndUploadSegments(
  s3Client: S3Client,
  segmentDir: string,
  botId: string,
  onSegmentUploaded?: (segmentKey: string, segmentNumber: number) => void
): () => void {

  const uploadedSegments = new Set<string>();
  let previousSegment: string | null = null;

  console.log(`Starting segment watcher for directory: ${segmentDir}`);

  const uploadSegment = async (filename: string) => {
    if (uploadedSegments.has(filename)) return;

    const segmentPath = path.join(segmentDir, filename);

    try {
      // Read segment file
      const fileContent = readFileSync(segmentPath);

      // Extract segment number from filename (segment_000.mp4 -> 0)
      const segmentMatch = filename.match(/segment_(\d+)\.mp4/);
      const segmentNumber = segmentMatch ? parseInt(segmentMatch[1]) : 0;

      // Upload to S3 with predictable path
      const key = `recordings/${botId}/segment_${segmentNumber.toString().padStart(3, '0')}.mp4`;

      console.log(`Uploading segment ${segmentNumber} (${(fileContent.length / 1024 / 1024).toFixed(2)} MB) to S3...`);

      await s3Client.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME!,
        Key: key,
        Body: fileContent,
        ContentType: 'video/mp4', // MP4 MIME type
      }));

      console.log(`Uploaded segment ${segmentNumber} to S3: ${key}`);
      uploadedSegments.add(filename);

      // Callback for event reporting
      onSegmentUploaded?.(key, segmentNumber);

    } catch (error) {
      console.error(`Error uploading segment ${filename}:`, error);
    }
  };

  const watcher = watch(segmentDir, async (eventType, filename) => {
    if (!filename || !filename.endsWith('.mp4')) return;

    console.log(`New segment detected: ${filename} (event: ${eventType})`);

    // When a new segment is created, upload the previous one (which is now complete)
    if (previousSegment && !uploadedSegments.has(previousSegment)) {
      console.log(`Uploading previous segment ${previousSegment} (current: ${filename})`);
      await uploadSegment(previousSegment);
    }

    // Update previous segment
    previousSegment = filename;
  });

  // Return cleanup function that uploads the final segment
  return () => {
    console.log('Stopping segment watcher');
    watcher.close();

    // Upload the last segment if it exists
    if (previousSegment && !uploadedSegments.has(previousSegment)) {
      console.log(`Uploading final segment: ${previousSegment}`);
      uploadSegment(previousSegment).catch(error =>
        console.error('Error uploading final segment:', error)
      );
    }
  };
}