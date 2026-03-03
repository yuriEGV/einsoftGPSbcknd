/**
 * Notification Service
 * Handles real-time alerts via email, SMS, and push notifications
 */

import nodemailer from 'nodemailer';
import twilio from 'twilio';

class NotificationService {
  constructor() {
    // Email configuration
    this.emailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    // SMS configuration (Twilio)
    this.twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );
  }

  // Send email alert
  async sendEmailAlert(recipient, subject, message, alertData) {
    try {
      const htmlContent = this.formatEmailTemplate(subject, message, alertData);

      await this.emailTransport.sendMail({
        from: process.env.EMAIL_FROM,
        to: recipient,
        subject: `[Einsoft GPS Alert] ${subject}`,
        html: htmlContent,
      });

      console.log(`📧 Email alert sent to ${recipient}`);
      return { success: true, channel: 'email' };
    } catch (error) {
      console.error('Error sending email alert:', error);
      return { success: false, error: error.message };
    }
  }

  // Send SMS alert
  async sendSMSAlert(phoneNumber, message) {
    try {
      await this.twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE,
        to: phoneNumber,
      });

      console.log(`📱 SMS alert sent to ${phoneNumber}`);
      return { success: true, channel: 'sms' };
    } catch (error) {
      console.error('Error sending SMS alert:', error);
      return { success: false, error: error.message };
    }
  }

  // Send push notification (via Socket.io or Firebase)
  async sendPushNotification(userId, title, message, data) {
    try {
      // This would integrate with Firebase Cloud Messaging or Socket.io
      console.log(`🔔 Push notification queued for user ${userId}`);
      return { success: true, channel: 'push' };
    } catch (error) {
      console.error('Error sending push notification:', error);
      return { success: false, error: error.message };
    }
  }

  // Send dashboard notification (in-app alert)
  async sendDashboardAlert(companyId, alertData) {
    // Broadcast via Socket.io
    return { success: true, channel: 'dashboard' };
  }

  // Send multi-channel alert
  async sendMultiChannelAlert(recipient, channels, alert) {
    const results = [];

    for (const channel of channels) {
      let result;

      switch (channel) {
        case 'email':
          result = await this.sendEmailAlert(
            recipient.email,
            alert.subject,
            alert.message,
            alert.data
          );
          break;

        case 'sms':
          result = await this.sendSMSAlert(
            recipient.phone,
            alert.message
          );
          break;

        case 'push':
          result = await this.sendPushNotification(
            recipient.userId,
            alert.subject,
            alert.message,
            alert.data
          );
          break;

        case 'dashboard':
          result = await this.sendDashboardAlert(
            recipient.companyId,
            alert
          );
          break;

        default:
          result = { success: false, error: 'Unknown channel' };
      }

      results.push(result);
    }

    return results;
  }

  // Format email template
  formatEmailTemplate(subject, message, alertData) {
    return `
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; }
            .alert { background: #f8f9fa; padding: 20px; border-left: 4px solid #dc3545; }
            .vehicle-info { margin: 20px 0; }
            .vehicle-info strong { color: #333; }
          </style>
        </head>
        <body>
          <div class="alert">
            <h2>${subject}</h2>
            <p>${message}</p>
            
            <div class="vehicle-info">
              <strong>Vehicle:</strong> ${alertData.licensePlate || 'N/A'}<br>
              <strong>Driver:</strong> ${alertData.driver || 'N/A'}<br>
              <strong>Location:</strong> ${alertData.address || 'N/A'}<br>
              <strong>Time:</strong> ${new Date().toLocaleString()}<br>
            </div>

            <p>
              <a href="${process.env.API_URL}/dashboard" style="background: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px;">
                View Dashboard
              </a>
            </p>

            <hr>
            <p style="font-size: 12px; color: #666;">
              This is an automated alert from Einsoft GPS Fleet Management System
            </p>
          </div>
        </body>
      </html>
    `;
  }
}

export default NotificationService;
