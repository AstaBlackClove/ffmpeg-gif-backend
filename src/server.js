import express from "express";
import fileUpload from "express-fileupload";
import cors from "cors";
import { exec } from "child_process";
import ffmpegPath from "ffmpeg-static";
import path from "path";
import fs from "fs";
import os from "os";

const app = express();
app.use(cors());
app.use(
  fileUpload({
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit - perfect for ~30 second videos
    abortOnLimit: true,
    responseOnLimit:
      "File size limit exceeded. Please upload videos under 10MB (~30 seconds).",
    useTempFiles: true,
    tempFileDir: "/tmp/",
  })
);

// Utility function to escape file paths for shell commands
function escapeShellPath(filePath) {
  return `"${filePath.replace(/"/g, '\\"')}"`;
}

// Utility function to validate video file
function isValidVideoFile(filename) {
  const validExtensions = [
    ".mp4",
    ".avi",
    ".mov",
    ".mkv",
    ".wmv",
    ".flv",
    ".webm",
  ];
  const ext = path.extname(filename).toLowerCase();
  return validExtensions.includes(ext);
}

// POST /gif endpoint with enhanced settings and error handling
app.post("/gif", async (req, res) => {
  let inputPath = null;
  let outputPath = null;

  try {
    // Validate file upload
    if (!req.files || !req.files.video) {
      return res.status(400).json({ error: "No video uploaded" });
    }

    const video = req.files.video;

    // Validate file type
    if (!isValidVideoFile(video.name)) {
      return res.status(400).json({ error: "Invalid video file format" });
    }

    const tempDir = os.tmpdir();
    const timestamp = Date.now();
    inputPath = path.join(tempDir, `input-${timestamp}-${video.name}`);
    outputPath = path.join(tempDir, `gif-${timestamp}.gif`);

    // Extract and validate settings from request body
    const fps = Math.max(5, Math.min(30, parseInt(req.body.fps) || 15));
    const scale = Math.max(
      240,
      Math.min(1920, parseInt(req.body.scale) || 480)
    );
    const startTime = Math.max(0, parseFloat(req.body.startTime) || 0);
    const duration = Math.max(0, parseFloat(req.body.duration) || 0);

    console.log(`🎬 Processing video: ${video.name}`);
    console.log(
      `⚙️  Settings: ${fps}fps, ${scale}p, start: ${startTime}s, duration: ${duration}s`
    );

    // Save uploaded file
    await video.mv(inputPath);

    // Verify input file exists and has content
    if (!fs.existsSync(inputPath) || fs.statSync(inputPath).size === 0) {
      throw new Error("Failed to save uploaded file or file is empty");
    }

    // Build FFmpeg command with high-quality palette generation to eliminate dots/dithering
    let command = escapeShellPath(ffmpegPath);

    // Add start time if specified
    if (startTime > 0) {
      command += ` -ss ${startTime}`;
    }

    // Input file
    command += ` -i ${escapeShellPath(inputPath)}`;

    // Add duration if specified
    if (duration > 0) {
      command += ` -t ${duration}`;
    }

    // High-quality filter chain with proper palette generation to eliminate dots
    const filterComplex = `fps=${fps},scale=${scale}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:reserve_transparent=0:stats_mode=single[p];[s1][p]paletteuse=dither=floyd_steinberg:diff_mode=rectangle`;

    command += ` -filter_complex "${filterComplex}"`;
    command += ` -y`; // Overwrite output file
    command += ` ${escapeShellPath(outputPath)}`;

    console.log(`🔧 FFmpeg command: ${command}`);

    // Execute FFmpeg with timeout
    const child = exec(command, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("❌ FFmpeg error:", err.message);
        console.error("FFmpeg stderr:", stderr);

        // Try to provide more specific error messages
        let errorMessage = "FFmpeg processing failed";
        if (stderr.includes("Invalid data found")) {
          errorMessage = "Invalid or corrupted video file";
        } else if (stderr.includes("No such file")) {
          errorMessage = "File not found or access denied";
        } else if (stderr.includes("Permission denied")) {
          errorMessage = "Permission denied accessing file";
        }

        return res.status(500).json({
          error: errorMessage,
          details: process.env.NODE_ENV === "development" ? stderr : undefined,
        });
      }

      // Check if output file was created and has content
      if (!fs.existsSync(outputPath)) {
        console.error("❌ Output file not created");
        return res
          .status(500)
          .json({ error: "GIF generation failed - no output file created" });
      }

      const outputStats = fs.statSync(outputPath);
      if (outputStats.size === 0) {
        console.error("❌ Output file is empty");
        return res
          .status(500)
          .json({ error: "GIF generation failed - empty output file" });
      }

      console.log(
        `✅ GIF created successfully: ${outputPath} (${(
          outputStats.size /
          1024 /
          1024
        ).toFixed(2)}MB)`
      );

      // Send file with proper headers
      res.setHeader("Content-Type", "image/gif");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="converted-${timestamp}.gif"`
      );
      res.setHeader("Content-Length", outputStats.size.toString());

      // Stream the file to response
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on("end", () => {
        // Cleanup after successful download
        cleanup();
      });

      fileStream.on("error", (streamErr) => {
        console.error("❌ File stream error:", streamErr);
        cleanup();
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to send GIF file" });
        }
      });
    });

    // Handle process timeout
    child.on("exit", (code, signal) => {
      if (signal === "SIGTERM") {
        console.error("❌ FFmpeg process timed out");
        cleanup();
        if (!res.headersSent) {
          res.status(500).json({
            error: "Processing timed out - video may be too large or complex",
          });
        }
      }
    });
  } catch (err) {
    console.error("❌ Processing error:", err.message);
    cleanup();
    res.status(500).json({
      error: "Internal server error",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }

  // Cleanup function
  function cleanup() {
    try {
      if (inputPath && fs.existsSync(inputPath)) {
        fs.unlinkSync(inputPath);
        console.log("🧹 Cleaned up input file");
      }
      if (outputPath && fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log("🧹 Cleaned up output file");
      }
    } catch (cleanupErr) {
      console.error("⚠️  Cleanup error:", cleanupErr.message);
    }
  }
});

// POST /video-info endpoint - returns video information
app.post("/video-info", async (req, res) => {
  let inputPath = null;

  try {
    if (!req.files || !req.files.video) {
      return res.status(400).json({ error: "No video uploaded" });
    }

    const video = req.files.video;

    // Validate file type
    if (!isValidVideoFile(video.name)) {
      return res.status(400).json({ error: "Invalid video file format" });
    }

    const tempDir = os.tmpdir();
    inputPath = path.join(tempDir, `info-${Date.now()}-${video.name}`);

    await video.mv(inputPath);

    const command = `${escapeShellPath(ffmpegPath)} -i ${escapeShellPath(
      inputPath
    )} -f null - 2>&1`;

    exec(command, { timeout: 30000 }, (err, stdout, stderr) => {
      // Cleanup
      if (inputPath && fs.existsSync(inputPath)) {
        fs.unlinkSync(inputPath);
      }

      if (stderr) {
        // Parse video information from stderr
        const durationMatch = stderr.match(
          /Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/
        );
        const resolutionMatch = stderr.match(/(\d{3,4})x(\d{3,4})/);
        const fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s*fps/);
        const bitrateMatch = stderr.match(/bitrate: (\d+)\s*kb\/s/);

        if (durationMatch) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseInt(durationMatch[3]);
          const milliseconds = parseInt(durationMatch[4]);
          const totalSeconds =
            hours * 3600 + minutes * 60 + seconds + milliseconds / 100;

          res.json({
            duration: totalSeconds,
            width: resolutionMatch ? parseInt(resolutionMatch[1]) : null,
            height: resolutionMatch ? parseInt(resolutionMatch[2]) : null,
            fps: fpsMatch ? parseFloat(fpsMatch[1]) : null,
            bitrate: bitrateMatch ? parseInt(bitrateMatch[1]) : null,
            filename: video.name,
            fileSize: video.size,
          });
        } else {
          console.error("❌ Could not parse video duration from FFmpeg output");
          res
            .status(500)
            .json({ error: "Could not extract video information" });
        }
      } else {
        console.error("❌ No FFmpeg output received");
        res.status(500).json({ error: "FFmpeg info extraction failed" });
      }
    });
  } catch (err) {
    console.error("❌ Video info error:", err.message);

    // Cleanup on error
    if (inputPath && fs.existsSync(inputPath)) {
      try {
        fs.unlinkSync(inputPath);
      } catch (cleanupErr) {
        console.error("⚠️  Cleanup error:", cleanupErr.message);
      }
    }

    res.status(500).json({
      error: "Internal server error ",
      details: process.env.NODE_ENV === "development" ? err.message : undefined,
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    ffmpegPath: ffmpegPath ? "Available" : "Not found",
    uptime: process.uptime(),
  });
});

// Test FFmpeg installation
app.get("/test-ffmpeg", (req, res) => {
  exec(`${escapeShellPath(ffmpegPath)} -version`, (err, stdout, stderr) => {
    if (err) {
      res.status(500).json({
        error: "FFmpeg not working",
        details: err.message,
      });
    } else {
      const versionMatch = stdout.match(/ffmpeg version ([^\s]+)/);
      res.json({
        status: "FFmpeg is working",
        version: versionMatch ? versionMatch[1] : "Unknown",
        path: ffmpegPath,
      });
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("❌ Unhandled error:", err);
  res.status(500).json({
    error: "Internal server error",
    details: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

const port = process.env.PORT || 3001;
app.listen(port, () => {
  console.log(`🚀 Enhanced GIF Studio API running on port ${port}`);
  console.log(`📋 Available endpoints:`);
  console.log(`   POST /gif - Convert video to GIF`);
  console.log(`   POST /video-info - Get video metadata`);
  console.log(`   GET /health - Health check`);
  console.log(`   GET /test-ffmpeg - Test FFmpeg installation`);

  // Test FFmpeg on startup
  exec(`${escapeShellPath(ffmpegPath)} -version`, (err, stdout) => {
    if (err) {
      console.error("⚠️  FFmpeg not found or not working properly");
    } else {
      const versionMatch = stdout.match(/ffmpeg version ([^\s]+)/);
      console.log(
        `✅ FFmpeg ready: ${versionMatch ? versionMatch[1] : "Unknown version"}`
      );
    }
  });
});
