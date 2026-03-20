import { App, BlockAction, ViewSubmitAction } from '@slack/bolt';
import { ApiClient } from '../api-client';

/**
 * Registers Slack action and view-submission handlers for the HITL flow.
 * Supports both legacy OTP-only and generic human input.
 */
export function registerHitlActions(app: App, apiClient: ApiClient): void {
  // ----------------------------------------------------------------
  // Action: open_stream
  // ----------------------------------------------------------------
  app.action<BlockAction>('open_stream', async ({ ack, body, client, logger }) => {
    await ack();

    const actionContext = extractActionContext(body);
    if (!actionContext?.sessionId || !actionContext.tenantId) {
      logger.error('open_stream: missing session_id or tenant_id in action value');
      return;
    }

    try {
      const streamResponse = await apiClient.getStreamUrl(
        actionContext.sessionId,
        actionContext.tenantId,
      );

      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: `Stream ready for session \`${actionContext.sessionId}\``,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Stream Ready*\nSession: \`${actionContext.sessionId}\`\nExpires: ${streamResponse.expires_at}`,
            },
            accessory: {
              type: 'button',
              text: { type: 'plain_text', text: 'Open in Browser' },
              url: streamResponse.url,
              action_id: 'open_stream_link',
            },
          },
        ],
      });
    } catch (error) {
      logger.error(`open_stream failed: ${error}`);
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: `Failed to get stream URL: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  });

  app.action('open_stream_link', async ({ ack }) => {
    await ack();
  });

  // ----------------------------------------------------------------
  // Action: submit_input (generic human input)
  // Opens a dynamic modal based on the input_request metadata.
  // ----------------------------------------------------------------
  app.action<BlockAction>('submit_input', async ({ ack, body, client, logger }) => {
    await ack();

    const actionContext = extractActionContext(body);
    if (!actionContext?.sessionId || !actionContext.tenantId) {
      logger.error('submit_input: missing session_id or tenant_id in action value');
      return;
    }

    const inputRequest = actionContext.inputRequest;
    const modalTitle = inputRequest?.label
      ? inputRequest.label.slice(0, 24)
      : 'Submit Input';
    const placeholder = inputRequest?.placeholder || 'Enter the value';
    const sensitive = inputRequest?.sensitive === true;

    try {
      await client.views.open({
        trigger_id: body.trigger_id!,
        view: {
          type: 'modal',
          callback_id: 'input_modal_submit',
          private_metadata: JSON.stringify({
            session_id: actionContext.sessionId,
            tenant_id: actionContext.tenantId,
            input_type: inputRequest?.input_type || 'otp',
            step_index: inputRequest?.step_index ?? 0,
          }),
          title: { type: 'plain_text', text: modalTitle },
          submit: { type: 'plain_text', text: 'Submit' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'input',
              block_id: 'input_block',
              label: { type: 'plain_text', text: inputRequest?.label || 'Value' },
              element: {
                type: 'plain_text_input',
                action_id: 'input_value',
                placeholder: { type: 'plain_text', text: placeholder },
              },
            },
          ],
        },
      });
    } catch (error) {
      logger.error(`submit_input modal open failed: ${error}`);
    }
  });

  // ----------------------------------------------------------------
  // Action: submit_otp (legacy, kept for backwards compatibility)
  // ----------------------------------------------------------------
  app.action<BlockAction>('submit_otp', async ({ ack, body, client, logger }) => {
    await ack();

    const actionContext = extractActionContext(body);
    if (!actionContext?.sessionId || !actionContext.tenantId) {
      logger.error('submit_otp: missing session_id or tenant_id in action value');
      return;
    }

    try {
      await client.views.open({
        trigger_id: body.trigger_id!,
        view: {
          type: 'modal',
          callback_id: 'otp_modal_submit',
          private_metadata: JSON.stringify({
            session_id: actionContext.sessionId,
            tenant_id: actionContext.tenantId,
          }),
          title: { type: 'plain_text', text: 'Submit OTP Code' },
          submit: { type: 'plain_text', text: 'Submit' },
          close: { type: 'plain_text', text: 'Cancel' },
          blocks: [
            {
              type: 'input',
              block_id: 'otp_block',
              label: { type: 'plain_text', text: 'OTP Code' },
              element: {
                type: 'plain_text_input',
                action_id: 'otp_value',
                placeholder: {
                  type: 'plain_text',
                  text: 'Enter the OTP code shown on screen',
                },
              },
            },
          ],
        },
      });
    } catch (error) {
      logger.error(`submit_otp modal open failed: ${error}`);
    }
  });

  // ----------------------------------------------------------------
  // View submission: input_modal_submit (generic)
  // ----------------------------------------------------------------
  app.view<ViewSubmitAction>('input_modal_submit', async ({ ack, view, logger }) => {
    const metadata = JSON.parse(view.private_metadata || '{}');
    const { session_id: sessionId, tenant_id: tenantId, input_type: inputType, step_index: stepIndex } = metadata;
    const value = view.state.values.input_block.input_value.value;

    if (!sessionId || !tenantId || !value) {
      await ack({
        response_action: 'errors',
        errors: { input_block: 'Value is required.' },
      });
      return;
    }

    try {
      await apiClient.submitInput(sessionId, inputType, value, stepIndex, tenantId);
      await ack();
    } catch (error) {
      logger.error(`Input submission failed: ${error}`);
      await ack({
        response_action: 'errors',
        errors: {
          input_block: `Failed to submit: ${error instanceof Error ? error.message : 'unknown error'}`,
        },
      });
    }
  });

  // ----------------------------------------------------------------
  // View submission: otp_modal_submit (legacy)
  // ----------------------------------------------------------------
  app.view<ViewSubmitAction>('otp_modal_submit', async ({ ack, view, logger }) => {
    const metadata = JSON.parse(view.private_metadata || '{}');
    const sessionId = metadata.session_id;
    const tenantId = metadata.tenant_id;
    const otpValue = view.state.values.otp_block.otp_value.value;

    if (!sessionId || !tenantId || !otpValue) {
      await ack({
        response_action: 'errors',
        errors: { otp_block: 'OTP code is required.' },
      });
      return;
    }

    try {
      await apiClient.submitOtp(sessionId, otpValue, tenantId);
      await ack();
    } catch (error) {
      logger.error(`OTP submission failed: ${error}`);
      await ack({
        response_action: 'errors',
        errors: {
          otp_block: `Failed to submit OTP: ${error instanceof Error ? error.message : 'unknown error'}`,
        },
      });
    }
  });

  // ----------------------------------------------------------------
  // Action: confirm_resolved (for input_type: 'confirm')
  // ----------------------------------------------------------------
  app.action<BlockAction>('confirm_resolved', async ({ ack, body, client, logger }) => {
    await ack();

    const actionContext = extractActionContext(body);
    if (!actionContext?.sessionId || !actionContext.tenantId) {
      logger.error('confirm_resolved: missing session_id or tenant_id');
      return;
    }

    const stepIndex = actionContext.inputRequest?.step_index ?? 0;

    try {
      await apiClient.submitInput(
        actionContext.sessionId,
        'confirm',
        'resolved',
        stepIndex,
        actionContext.tenantId,
      );

      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: 'Marked as resolved. Automation resuming.',
      });
    } catch (error) {
      logger.error(`confirm_resolved failed: ${error}`);
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: `Failed to confirm: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  });

  // ----------------------------------------------------------------
  // Action: release_control
  // ----------------------------------------------------------------
  app.action<BlockAction>('release_control', async ({ ack, body, client, logger }) => {
    await ack();

    const actionContext = extractActionContext(body);
    if (!actionContext?.sessionId || !actionContext.tenantId) {
      logger.error('release_control: missing session_id or tenant_id in action value');
      return;
    }

    try {
      const releaseResponse = await apiClient.releaseControl(
        actionContext.sessionId,
        actionContext.tenantId,
      );

      await client.chat.postMessage({
        channel: body.channel?.id || '',
        text: `Session \`${actionContext.sessionId}\` released (baton: ${releaseResponse.baton_state}). What happened? Anything unusual?`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Session Released*\nSession: \`${actionContext.sessionId}\`\nBaton state: \`${releaseResponse.baton_state}\``,
            },
          },
          {
            type: 'input',
            dispatch_action: true,
            block_id: `release_notes_${actionContext.sessionId}`,
            label: { type: 'plain_text', text: 'What happened? Anything unusual?' },
            element: {
              type: 'plain_text_input',
              action_id: 'release_notes_input',
              multiline: true,
              placeholder: {
                type: 'plain_text',
                text: 'Describe what you did and any issues observed...',
              },
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Submit Notes' },
                action_id: 'release_notes_submit',
                value: JSON.stringify({
                  session_id: actionContext.sessionId,
                  tenant_id: actionContext.tenantId,
                }),
                style: 'primary',
              },
            ],
          },
        ],
      });
    } catch (error) {
      logger.error(`release_control failed: ${error}`);
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: `Failed to release control: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  });

  // ----------------------------------------------------------------
  // Action: release_notes_submit
  // ----------------------------------------------------------------
  app.action<BlockAction>('release_notes_submit', async ({ ack, body, client, logger }) => {
    await ack();

    const actionContext = extractActionContext(body);
    if (!actionContext?.sessionId || !actionContext.tenantId) {
      logger.error('release_notes_submit: missing session_id or tenant_id in action value');
      return;
    }

    const stateValues = (body as any).state?.values || {};
    const notesBlockKey = `release_notes_${actionContext.sessionId}`;
    const note = stateValues[notesBlockKey]?.release_notes_input?.value || '';

    try {
      await apiClient.acknowledgeSession(actionContext.sessionId, note, actionContext.tenantId);

      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: `Notes recorded for session \`${actionContext.sessionId}\`. Thank you!`,
      });
    } catch (error) {
      logger.error(`release_notes_submit failed: ${error}`);
      await client.chat.postEphemeral({
        channel: body.channel?.id || '',
        user: body.user.id,
        text: `Failed to store notes: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  });
}

/**
 * Extract session/tenant/input_request context from an action's value field.
 */
function extractActionContext(body: any): {
  sessionId: string;
  tenantId: string;
  inputRequest?: { input_type: string; label: string; placeholder?: string; sensitive?: boolean; step_index: number };
} | null {
  const actions = body.actions || [];
  for (const action of actions) {
    if (action.value) {
      try {
        const parsed = JSON.parse(action.value);
        if (parsed.session_id && parsed.tenant_id) {
          return {
            sessionId: parsed.session_id,
            tenantId: parsed.tenant_id,
            inputRequest: parsed.input_request || undefined,
          };
        }
      } catch {
        const defaultTenant = process.env.SERVICE_AUTH_DEFAULT_TENANT_ID || '';
        if (defaultTenant) {
          return { sessionId: action.value, tenantId: defaultTenant };
        }
      }
    }
  }
  return null;
}
