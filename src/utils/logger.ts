import winston from 'winston';
import chalk from 'chalk';

const logLevels = {
  error: 0,
  warn: 1,
  success: 2,
  info: 3,
  debug: 4,
};

const logColors: Record<string, string> = {
  error: 'red',
  warn: 'yellow',
  success: 'green',
  info: 'cyan',
  debug: 'blue',
};

const consoleFormat = winston.format.printf(({ level, message, timestamp }) => {
  const color = logColors[level] || 'white';
  const levelText = level.toUpperCase().padEnd(7);
  return `${chalk.gray(timestamp as string)} ${(chalk as any)[color](levelText)} ${message}`;
});

export const logger = winston.createLogger({
  levels: logLevels,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    consoleFormat
  ),
  transports: [
    new winston.transports.Console({
      level: process.env.LOG_LEVEL || 'info',
    }),
  ],
}) as winston.Logger & { success: winston.LeveledLogMethod };
