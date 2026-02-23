import {
  TurnContext,
  CardFactory,
  MessageFactory,
  Attachment,
} from 'botbuilder';
import { ApiClient } from '../api-client';

/**
 * Handles Teams Adaptive Card action submissions for the HITL flow.
 * Per spec section 12.2: Teams bot uses Adaptive Cards with Action.Submit
 * for Open Stream, Submit OTP, Release Control, and notes capture.
 */
export class HitlActionHandler {
  constructor(private readonly apiClient: ApiClient) {}

  /**
   * Process an incoming Action.Submit from an Adaptive Card.
   * Routes to the appropriate handler based on the action type.
   */
  async handleAdaptiveCardAction(context: TurnContext): Promise<void> {
    const value = context.activity.value;
    if (!value || !value.action) {
      return;
    }

    switch (value.action) {
      case 'open_stream':
        await this.handleOpenStream(context, value.session_id, value.tenant_id);
        break;
      case 'submit_otp':
        await this.handleSubmitOtp(context, value.session_id, value.tenant_id, value.otp_value);
        break;
      case 'release_control':
        await this.handleReleaseControl(context, value.session_id, value.tenant_id);
        break;
      case 'release_notes_submit':
        await this.handleReleaseNotes(context, value.session_id, value.tenant_id, value.notes);
        break;
      default:
        console.log(`[HitlActionHandler] Unknown action: ${value.action}`);
    }
  }

  /**
   * Handle "Open Stream" action: fetch stream URL and send it to the user.
   */
  private async handleOpenStream(
    context: TurnContext,
    sessionId: string,
    tenantId?: string,
  ): Promise<void> {
    if (!sessionId || !tenantId) {
      await context.sendActivity('Error: missing session or tenant ID.');
      return;
    }

    try {
      const streamResponse = await this.apiClient.getStreamUrl(sessionId, tenantId);

      const card = CardFactory.adaptiveCard({
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: 'Stream Ready',
            weight: 'Bolder',
            size: 'Medium',
          },
          {
            type: 'FactSet',
            facts: [
              { title: 'Session', value: sessionId },
              { title: 'Expires', value: streamResponse.expires_at },
            ],
          },
        ],
        actions: [
          {
            type: 'Action.OpenUrl',
            title: 'Open in Browser',
            url: streamResponse.url,
          },
        ],
      });

      await context.sendActivity(MessageFactory.attachment(card));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await context.sendActivity(`Failed to get stream URL: ${message}`);
    }
  }

  /**
   * Handle "Submit OTP" action: relay OTP value to the API.
   * If no OTP value provided, send an input card.
   */
  private async handleSubmitOtp(
    context: TurnContext,
    sessionId: string,
    tenantId?: string,
    otpValue?: string,
  ): Promise<void> {
    if (!sessionId || !tenantId) {
      await context.sendActivity('Error: missing session or tenant ID.');
      return;
    }

    // If no OTP value yet, prompt for it with an input card
    if (!otpValue) {
      const card = this.buildOtpInputCard(sessionId, tenantId);
      await context.sendActivity(MessageFactory.attachment(card));
      return;
    }

    try {
      await this.apiClient.submitOtp(sessionId, otpValue, tenantId);
      await context.sendActivity(`OTP submitted successfully for session \`${sessionId}\`.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await context.sendActivity(`Failed to submit OTP: ${message}`);
    }
  }

  /**
   * Handle "Release Control" action: release baton, then prompt for notes.
   */
  private async handleReleaseControl(
    context: TurnContext,
    sessionId: string,
    tenantId?: string,
  ): Promise<void> {
    if (!sessionId || !tenantId) {
      await context.sendActivity('Error: missing session or tenant ID.');
      return;
    }

    try {
      const releaseResponse = await this.apiClient.releaseControl(sessionId, tenantId);

      // Send the release confirmation with a notes prompt
      const card = CardFactory.adaptiveCard({
        type: 'AdaptiveCard',
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        version: '1.4',
        body: [
          {
            type: 'TextBlock',
            text: 'Session Released',
            weight: 'Bolder',
            size: 'Medium',
          },
          {
            type: 'FactSet',
            facts: [
              { title: 'Session', value: sessionId },
              { title: 'Baton State', value: releaseResponse.baton_state },
            ],
          },
          {
            type: 'TextBlock',
            text: 'What happened? Anything unusual?',
            wrap: true,
          },
          {
            type: 'Input.Text',
            id: 'notes',
            placeholder: 'Describe what you did and any issues observed...',
            isMultiline: true,
          },
        ],
        actions: [
          {
            type: 'Action.Submit',
            title: 'Submit Notes',
            data: {
              action: 'release_notes_submit',
              session_id: sessionId,
              tenant_id: tenantId,
            },
          },
        ],
      });

      await context.sendActivity(MessageFactory.attachment(card));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await context.sendActivity(`Failed to release control: ${message}`);
    }
  }

  /**
   * Handle notes submission after release.
   */
  private async handleReleaseNotes(
    context: TurnContext,
    sessionId: string,
    tenantId: string | undefined,
    notes: string,
  ): Promise<void> {
    if (!sessionId || !tenantId) {
      await context.sendActivity('Error: missing session or tenant ID.');
      return;
    }

    try {
      await this.apiClient.acknowledgeSession(sessionId, notes || '', tenantId);
      await context.sendActivity(
        `Notes recorded for session \`${sessionId}\`. Thank you!`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await context.sendActivity(`Failed to store notes: ${message}`);
    }
  }

  // ----------------------------------------------------------------
  // Card builders for NATS-triggered notifications
  // ----------------------------------------------------------------

  /**
   * Build the HITL started interactive card.
   * Posted when a hitl.started event is received from NATS.
   */
  buildHitlStartedCard(
    sessionId: string,
    appId: string,
    reason: string,
    interventionId: string,
    tenantId: string,
    timestamp: string,
  ): Attachment {
    return CardFactory.adaptiveCard({
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: 'Human Intervention Required',
          weight: 'Bolder',
          size: 'Large',
          color: 'Attention',
        },
        {
          type: 'FactSet',
          facts: [
            { title: 'Session', value: sessionId },
            { title: 'Application', value: appId },
            { title: 'Reason', value: reason },
            { title: 'Intervention', value: interventionId },
          ],
        },
        {
          type: 'TextBlock',
          text: `Tenant: ${tenantId} | Received: ${timestamp}`,
          size: 'Small',
          isSubtle: true,
        },
      ],
      actions: [
        {
          type: 'Action.Submit',
          title: 'Open Stream',
          data: { action: 'open_stream', session_id: sessionId, tenant_id: tenantId },
          style: 'positive',
        },
        {
          type: 'Action.Submit',
          title: 'Submit OTP',
          data: { action: 'submit_otp', session_id: sessionId, tenant_id: tenantId },
        },
        {
          type: 'Action.Submit',
          title: 'Release Control',
          data: { action: 'release_control', session_id: sessionId, tenant_id: tenantId },
          style: 'destructive',
        },
      ],
    });
  }

  /**
   * Build the OTP requested card.
   * Posted when a hitl.otp-requested event is received from NATS.
   */
  buildOtpRequestedCard(
    sessionId: string,
    appId: string,
    appName: string,
    tenantId: string,
    timestamp: string,
  ): Attachment {
    return CardFactory.adaptiveCard({
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: 'OTP Code Required',
          weight: 'Bolder',
          size: 'Large',
          color: 'Warning',
        },
        {
          type: 'TextBlock',
          text: `Application **${appName}** (${appId}) is requesting an OTP code.`,
          wrap: true,
        },
        {
          type: 'FactSet',
          facts: [{ title: 'Session', value: sessionId }],
        },
        {
          type: 'Input.Text',
          id: 'otp_value',
          placeholder: 'Enter the OTP code shown on screen',
          label: 'OTP Code',
        },
        {
          type: 'TextBlock',
          text: `Tenant: ${tenantId} | Received: ${timestamp}`,
          size: 'Small',
          isSubtle: true,
        },
      ],
      actions: [
        {
          type: 'Action.Submit',
          title: 'Submit OTP',
          data: { action: 'submit_otp', session_id: sessionId, tenant_id: tenantId },
          style: 'positive',
        },
        {
          type: 'Action.Submit',
          title: 'Open Stream',
          data: { action: 'open_stream', session_id: sessionId, tenant_id: tenantId },
        },
      ],
    });
  }

  /**
   * Build a standalone OTP input card for when a user clicks Submit OTP without a value.
   */
  private buildOtpInputCard(sessionId: string, tenantId: string): Attachment {
    return CardFactory.adaptiveCard({
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: 'Enter OTP Code',
          weight: 'Bolder',
          size: 'Medium',
        },
        {
          type: 'Input.Text',
          id: 'otp_value',
          placeholder: 'Enter the OTP code',
          label: 'OTP Code',
        },
      ],
      actions: [
        {
          type: 'Action.Submit',
          title: 'Submit',
          data: { action: 'submit_otp', session_id: sessionId, tenant_id: tenantId },
          style: 'positive',
        },
      ],
    });
  }
}
