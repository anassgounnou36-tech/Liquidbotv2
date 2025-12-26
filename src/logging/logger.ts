import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}] : ${message}`;
  
  // Add metadata if present
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  
  return msg;
});

// Create the logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        logFormat
      )
    })
  ]
});

// Add file transport if LOG_FILE is specified
if (process.env.LOG_FILE) {
  logger.add(new winston.transports.File({ 
    filename: process.env.LOG_FILE,
    format: combine(
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
      logFormat
    )
  }));
}

// Export logger instance
export default logger;

// Helper function to update log level at runtime
export function setLogLevel(level: string): void {
  logger.level = level;
  logger.info(`Log level changed to: ${level}`);
}
