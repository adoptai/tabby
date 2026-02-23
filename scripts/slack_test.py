#!/usr/bin/env python3
import json
import os
import sys
import urllib.parse
import urllib.request
from typing import Optional


SLACK_BOT_TOKEN = os.environ.get("SLACK_BOT_TOKEN")
SLACK_CHANNEL_ID = os.environ.get("SLACK_CHANNEL_ID")
SLACK_CHANNEL_NAME = os.environ.get("SLACK_CHANNEL_NAME", "tabby-experiments")


class SlackApiError(RuntimeError):
    def __init__(self, method: str, payload: dict):
        self.method = method
        self.payload = payload
        super().__init__(f"{method} failed: {payload.get('error')} | full={payload}")


def slack_api(method: str, params: Optional[dict] = None) -> dict:
    if params is None:
        params = {}
    body = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        f"https://slack.com/api/{method}",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {SLACK_BOT_TOKEN}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    if not payload.get("ok", False):
        raise SlackApiError(method, payload)
    return payload


def list_channels_by_type(channel_type: str) -> list[dict]:
    channels: list[dict] = []
    cursor = ""
    while True:
        params = {
            "types": channel_type,
            "exclude_archived": "true",
            "limit": "200",
        }
        if cursor:
            params["cursor"] = cursor

        result = slack_api("conversations.list", params)
        channels.extend(result.get("channels") or [])

        cursor = ((result.get("response_metadata") or {}).get("next_cursor") or "").strip()
        if not cursor:
            break
    return channels


def find_channel_id_by_name(channel_name: str) -> str:
    private_channels = list_channels_by_type("private_channel")
    for ch in private_channels:
        name = ch.get("name") or ""
        name_normalized = ch.get("name_normalized") or ""
        if name == channel_name or name_normalized == channel_name:
            return ch.get("id")

    try:
        public_channels = list_channels_by_type("public_channel")
    except SlackApiError as err:
        if err.payload.get("error") == "missing_scope":
            needed = err.payload.get("needed")
            raise RuntimeError(
                f"Channel '{channel_name}' not found in private channels visible to this bot. "
                f"Public-channel discovery requires scope '{needed}'. "
                "Either add the scope and reinstall, or set SLACK_CHANNEL_ID directly."
            ) from err
        raise

    for ch in public_channels:
        name = ch.get("name") or ""
        name_normalized = ch.get("name_normalized") or ""
        if name == channel_name or name_normalized == channel_name:
            return ch.get("id")

    raise RuntimeError(
        f"Channel '{channel_name}' not found via conversations.list. "
        "If private, invite the bot. If public, ensure channels:read scope is granted."
    )


def main() -> None:
    if not SLACK_BOT_TOKEN:
        print(
            "Set env vars:\n"
            "  export SLACK_BOT_TOKEN='xoxb-...'\n"
            "Optional:\n"
            "  export SLACK_CHANNEL_ID='C... or G...'\n"
            "  export SLACK_CHANNEL_NAME='tabby-experiments'\n"
        )
        sys.exit(2)

    me = slack_api("auth.test")
    print(f"[auth.test] ok - authed as user={me.get('user')} team={me.get('team')}")

    channel_id = SLACK_CHANNEL_ID
    channel_target_for_post = channel_id
    if channel_id:
        print(f"[channel] using provided SLACK_CHANNEL_ID={channel_id}")
    else:
        try:
            channel_id = find_channel_id_by_name(SLACK_CHANNEL_NAME)
            channel_target_for_post = channel_id
            print(f"[channel] resolved name '{SLACK_CHANNEL_NAME}' -> {channel_id}")
        except Exception as lookup_err:  # noqa: BLE001
            print(f"[channel lookup] warning - {lookup_err}")
            channel_target_for_post = (
                SLACK_CHANNEL_NAME
                if SLACK_CHANNEL_NAME.startswith("#")
                else f"#{SLACK_CHANNEL_NAME}"
            )
            print(f"[channel] fallback to chat.postMessage target={channel_target_for_post!r}")

    text = f"tabby-experiments bot smoke test (pid={os.getpid()})"
    post = slack_api("chat.postMessage", {"channel": channel_target_for_post, "text": text})
    channel_id = post.get("channel") or channel_id
    print(f"[chat.postMessage] ok - channel={channel_id} ts={post.get('ts')}")
    if not channel_id:
        raise RuntimeError("Unable to resolve channel ID from chat.postMessage response")

    info = slack_api("conversations.info", {"channel": channel_id})
    ch = info.get("channel", {})
    print(
        f"[conversations.info] ok - name={ch.get('name')} "
        f"is_private={ch.get('is_private')} is_member={ch.get('is_member')}"
    )

    hist = slack_api("conversations.history", {"channel": channel_id, "limit": 1})
    msg = (hist.get("messages") or [{}])[0]
    print(
        "[conversations.history] ok - "
        f"latest_ts={msg.get('ts')} latest_text={msg.get('text')!r}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"\nERROR: {e}\n")
        print("Common fixes:")
        print("- 'not_in_channel': someone must /invite the bot to the channel.")
        print("- 'missing_scope': add scopes, then reinstall the app to workspace.")
        raise
