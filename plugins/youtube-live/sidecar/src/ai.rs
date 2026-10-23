//! OpenAI calls (through `http.fetch`, key = secret `openai.apiKey`): text to
//! speech for announcements and the chat completion behind AI-generated polls.

use crate::error::{Result, YouTubeLiveError};
use crate::models::GeneratedPoll;
use crate::state::App;
use quadflow_sidecar::{json, Value};

const OPENAI_TTS_URL: &str = "https://api.openai.com/v1/audio/speech";
const OPENAI_CHAT_URL: &str = "https://api.openai.com/v1/chat/completions";

fn api_key(app: &App) -> Result<String> {
    app.state()
        .get_db()
        .get_settings()?
        .openai_api_key
        .filter(|k| !k.is_empty())
        .ok_or_else(|| YouTubeLiveError::NotConfigured("OpenAI API key not configured. Add it in YouTube Live Settings → AI.".into()))
}

/// Speak `text` with the configured voice/model; returns base64 MP3.
pub fn tts_speak(app: &App, text: &str) -> Result<String> {
    let key = api_key(app)?;
    let s = app.state().get_db().get_settings()?;
    let body = json!({ "model": s.tts_model, "input": text, "voice": s.tts_voice, "response_format": "mp3" });
    let resp = app.http().post_json(OPENAI_TTS_URL, &key, &body)?;
    if !resp.is_success() {
        return Err(YouTubeLiveError::Api(format!("OpenAI TTS error ({}): {}", resp.status, resp.text())));
    }
    Ok(resp.body_base64)
}

/// One system + user chat completion with the configured model.
pub fn complete(app: &App, system: &str, user: &str) -> Result<String> {
    let key = api_key(app)?;
    let model = app.state().get_db().get_settings()?.ai_model;
    let body = json!({
        "model": model,
        "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
    });
    let resp = app.http().post_json(OPENAI_CHAT_URL, &key, &body)?;
    if !resp.is_success() {
        return Err(YouTubeLiveError::Api(format!("OpenAI chat error ({}): {}", resp.status, resp.text())));
    }
    let v: Value = resp.json()?;
    v.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| YouTubeLiveError::Api("OpenAI response has no message content".into()))
}

pub const POLL_SYSTEM_PROMPT: &str = r#"You are a helpful assistant that generates engaging YouTube live stream polls for a coding/programming stream.

Your task is to generate a poll question with 2-4 options based on the provided context. The poll should be:
- Relevant to the current discussion or coding topic
- Fun and engaging for viewers
- Easy to answer quickly

IMPORTANT: You MUST respond with ONLY valid JSON in this exact format, no other text:
{"question": "Your question here?", "options": ["Option 1", "Option 2", "Option 3", "Option 4"]}

Rules:
- Question should be concise (under 100 characters)
- Each option should be short (under 50 characters)
- Provide 2-4 options
- Make options mutually exclusive and clear"#;

/// Parse the model's answer (plain JSON or a fenced code block) into a poll.
pub fn parse_generated_poll(content: &str, context: &str) -> std::result::Result<GeneratedPoll, String> {
    let trimmed = content.trim();
    let json_str = if trimmed.starts_with("```") {
        trimmed.lines().skip(1).take_while(|l| !l.starts_with("```")).collect::<Vec<_>>().join("\n")
    } else {
        trimmed.to_string()
    };
    let parsed: Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse LLM response as JSON: {}. Response was: {}", e, content))?;
    let question = parsed
        .get("question")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing 'question' field in LLM response".to_string())?
        .to_string();
    let options: Vec<String> = parsed
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing 'options' field in LLM response".to_string())?
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    if options.len() < 2 || options.len() > 4 {
        return Err(format!("LLM generated {} options, but YouTube requires 2-4", options.len()));
    }
    let chars = context.chars().count();
    let source_context = context.chars().take(200).collect::<String>() + if chars > 200 { "..." } else { "" };
    Ok(GeneratedPoll { question, options, source_context })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_and_fenced_answers() {
        let p = parse_generated_poll(r#"{"question":"Tabs?","options":["Tabs","Spaces"]}"#, "ctx").unwrap();
        assert_eq!(p.options, vec!["Tabs", "Spaces"]);
        let p = parse_generated_poll("```json\n{\"question\":\"Q?\",\"options\":[\"a\",\"b\",\"c\"]}\n```", &"é".repeat(300)).unwrap();
        assert_eq!(p.options.len(), 3);
        assert!(p.source_context.ends_with("..."));
        assert!(parse_generated_poll(r#"{"question":"Q","options":["only"]}"#, "").is_err());
        assert!(parse_generated_poll("nope", "").is_err());
    }
}
