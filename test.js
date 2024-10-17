import { SerialPort } from 'serialport';
import sharp from 'sharp';
import { spawn } from 'child_process';

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection:', reason);
});

// Serial port configuration
const port = new SerialPort({
  path: '/dev/cu.usbserial-B001KF6U', // Update with your actual device path
  baudRate: 57600,
});

port.on('open', () => {
  console.log('Serial Port Opened');
});

port.on('error', (err) => {
  console.error('Serial Port Error:', err.message);
});

// Flip-disc display configuration
const DISPLAY_WIDTH = 28; // Single display width (28 columns)
const DISPLAY_HEIGHT_SINGLE = 7; // Single display height
const DISPLAY_HEIGHT_TOTAL = DISPLAY_HEIGHT_SINGLE; // Total height for

// FFmpeg command to capture video frames from the camera
console.log('Starting FFmpeg process...');
const ffmpeg = spawn('ffmpeg', [
  '-f', 'avfoundation',
  '-framerate', '30', // Use 30 fps
  '-video_size', '640x480',
  '-i', '0:none', // Specify device index 0 for video and 'none' for audio
  '-vf', 'format=gray',
  '-pix_fmt', 'gray',
  '-f', 'rawvideo',
  'pipe:1',
]);

ffmpeg.stderr.on('data', (data) => {
  console.error(`FFmpeg stderr: ${data}`);
});

ffmpeg.on('error', (error) => {
  console.error('Error starting FFmpeg:', error);
});

ffmpeg.on('close', (code) => {
  console.log(`FFmpeg process exited with code ${code}`);
});

// Buffer to store incoming frame data
let frameBuffer = Buffer.alloc(0);

// Expected frame size (grayscale, 1 byte per pixel)
const frameWidth = 640;
const frameHeight = 480;
const frameSize = frameWidth * frameHeight;

console.log('Waiting for frames from FFmpeg...');
// Process frames from FFmpeg
ffmpeg.stdout.on('data', (data) => {
  frameBuffer = Buffer.concat([frameBuffer, data]);

  while (frameBuffer.length >= frameSize) {
    const frameData = frameBuffer.slice(0, frameSize);
    frameBuffer = frameBuffer.slice(frameSize);

    // Process the frame
    processFrame(frameData);
  }
});

async function processFrame(frameData) {
  try {
    console.log('Processing frame...');
    // Process the image using sharp
    const image = sharp(frameData, {
      raw: {
        width: frameWidth,
        height: frameHeight,
        channels: 1,
      },
    });

    // Step 1: Resize the image to fit the stacked displays (28 pixels wide and 14 pixels high)
    const PIXELATED_WIDTH = DISPLAY_WIDTH;       // Match display width (28 columns)
    const PIXELATED_HEIGHT = DISPLAY_HEIGHT_TOTAL*2; // Total height for both displays (7 + 7)

    const processedImage = image
      .resize(PIXELATED_WIDTH, PIXELATED_HEIGHT, {
        fit: 'fill', // Ensure the entire camera view fits within the display resolution
        kernel: sharp.kernel.nearest, // Maintain pixelation
        background: { r: 0, g: 0, b: 0 }, // Add black padding if needed to maintain aspect ratio
      })
      .flop() // Flip the image horizontally to correct mirroring
      .threshold(128);

    // Step 2: Save the processed image for debugging (enlarged pixelated version)
    const SCALE_FACTOR = 20;  // Adjust this to change the size of the debug image (png)
    await processedImage
      .resize(PIXELATED_WIDTH * SCALE_FACTOR, PIXELATED_HEIGHT * SCALE_FACTOR, {
        kernel: sharp.kernel.nearest, // Keep pixelation when scaling up for visibility
      })
      .png()
      .toFile('current_frame.png');

    // Step 3: Get the raw buffer to send to the flip-disc displays
    const resizedImageBuffer = await processedImage
      .raw()
      .toBuffer();

    const bitmapData = resizedImageBuffer;
    const bitmapWidth = PIXELATED_WIDTH;
    const bitmapHeight = PIXELATED_HEIGHT;

    // Split the bitmap data into two parts: one for each display (side by side)
    const dataBytesDisplay1 = prepareDataBytes(bitmapData.slice(0, DISPLAY_WIDTH * DISPLAY_HEIGHT_SINGLE), DISPLAY_WIDTH);
    const dataBytesDisplay2 = prepareDataBytes(bitmapData.slice(DISPLAY_WIDTH * DISPLAY_HEIGHT_SINGLE), DISPLAY_WIDTH);

    // Enhanced debugging: Print the 7x56 grid representation of both displays side by side in yellow text
    console.log("\x1b[33mFlip-disc Display State (7 rows x 56 columns - Display 1 on left, Display 2 on right):\x1b[0m");

    // Print both Display 1 (left) and Display 2 (right) rows side by side
    for (let row = 0; row < DISPLAY_HEIGHT_SINGLE; row++) {
      let rowOutput1 = ""; // For Display 1 (Address 0)
      let rowOutput2 = ""; // For Display 2 (Address 1)

      for (let col = 0; col < DISPLAY_WIDTH; col++) {
        const byte1 = dataBytesDisplay1[col];
        const bit1 = (byte1 >> row) & 1;
        rowOutput1 += bit1 ? "1 " : "0 "; // Display 1: '1' for a dot that is on, '0' for off
      }

      for (let col = 0; col < DISPLAY_WIDTH; col++) {
        const byte2 = dataBytesDisplay2[col];
        const bit2 = (byte2 >> row) & 1;
        rowOutput2 += bit2 ? "1 " : "0 "; // Display 2: '1' for a dot that is on, '0' for off
      }

      // Log the output for both displays side by side
      console.log(`\x1b[33mRow ${DISPLAY_HEIGHT_SINGLE - row - 1}: ${rowOutput1.trim()} | ${rowOutput2.trim()}\x1b[0m`);
    }

    // Send the data to Display 1 (address 0)
    sendToDisplay(0, dataBytesDisplay1);

    // Send the data to Display 2 (address 1)
    sendToDisplay(1, dataBytesDisplay2);

  } catch (error) {
    console.error('Error processing frame:', error);
  }
}

function prepareDataBytes(bitmapData, bitmapWidth) {
  const dataBytes = [];
  const bitsPerByte = 7;

  for (let y = 0; y < DISPLAY_HEIGHT_SINGLE; y++) {
    let rowBytes = [];
    for (let byteIndex = 0; byteIndex < Math.ceil(bitmapWidth / bitsPerByte); byteIndex++) {
      let byte = 0;
      for (let bit = 0; bit < bitsPerByte; bit++) {
        const x = byteIndex * bitsPerByte + bit;
        if (x >= bitmapWidth) break;
        const idx = y * bitmapWidth + x;
        const pixelValue = bitmapData[idx];

        const bitValue = pixelValue === 255 ? 1 : 0; // White pixels are "on"
        const bitPosition = bit;

        byte |= bitValue << bitPosition;
      }
      byte &= 0x7F; // Ensure highest bit is 0
      rowBytes.push(byte);
    }
    dataBytes.push(...rowBytes);
  }

  return dataBytes;
}

function sendToDisplay(address, dataBytes) {
  const commandBuffer = Buffer.from([
    0x80, // Start byte
    0x83, // Command
    address, // RS485 address (0 or 1)
    ...dataBytes,
    0x8F, // End byte
  ]);

  if (port.isOpen) {
    port.write(commandBuffer, (err) => {
      if (err) {
        console.error(`Error on write to Display ${address}:`, err.message);
      } else {
        console.log(`Frame sent to Display ${address}`);
      }
    });
  } else {
    console.error('Serial port not open');
  }
}

// Keep the script running
setInterval(() => {}, 1000);
