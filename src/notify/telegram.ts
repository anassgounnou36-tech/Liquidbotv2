import { getConfig } from '../config/env';
import logger from '../logging/logger';

/**
 * Send a message to Telegram using the Bot API
 * @param text Message text to send
 * @returns Promise that resolves when message is sent (or fails gracefully)
 */
export async function sendTelegram(text: string): Promise<void> {
  const config = getConfig();
  
  // Check if Telegram is configured
  if (!config.telegramBotToken || !config.telegramChatId) {
    logger.debug('Telegram not configured, skipping notification');
    return;
  }
  
  try {
    const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
    const payload = {
      chat_id: config.telegramChatId,
      text: text,
      parse_mode: 'HTML'
    };
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.warn('Telegram API error', {
        status: response.status,
        error: errorText
      });
      return;
    }
    
    logger.debug('Telegram notification sent successfully');
  } catch (error) {
    // Gracefully handle errors - never throw
    logger.warn('Failed to send Telegram notification', { error });
  }
}
