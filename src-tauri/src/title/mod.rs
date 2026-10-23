//! API title generation: the shell's chat-endpoint fallback for terminal
//! titles. Local (llama.cpp) generation is the optional `local-titles`
//! plugin; the shell picks a generator in `src/lib/titles.ts` (plugin
//! `titleGenerators` contribution → agent provider `sessionTitle` → this API
//! → a heuristic).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TitleGenerateResult {
    pub title: String,
    pub used_device: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TitleApiOptions {
    pub model: String,
    pub min_words: u32,
    pub max_words: u32,
}

#[tauri::command]
pub async fn generate_title_via_api(
    core_state: tauri::State<'_, crate::core_state::CoreState>,
    prompt: String,
    options: TitleApiOptions,
) -> Result<TitleGenerateResult, String> {
    let (endpoint, api_key) = crate::ai_provider::chat_endpoint(&core_state).await?;

    if endpoint.is_empty() {
        return Err("No API endpoint configured. Set one in Settings > Integrations.".to_string());
    }

    let min_words = options.min_words.max(1);
    let max_words = options.max_words.max(min_words);
    let max_chars = 800;
    let trimmed = prompt.trim();
    let clipped = if trimmed.chars().count() > max_chars {
        let end = trimmed
            .char_indices()
            .nth(max_chars)
            .map(|(idx, _)| idx)
            .unwrap_or(trimmed.len());
        &trimmed[..end]
    } else {
        trimmed
    };

    let title_prompt = format!(
        "Generate a concise terminal title with {}-{} words. \
        Only output the title, no quotes, no trailing punctuation.\n\nPrompt:\n{}\n\nTitle:",
        min_words, max_words, clipped
    );

    let url = format!(
        "{}/chat/completions",
        endpoint.trim_end_matches('/')
    );

    let request_body = serde_json::json!({
        "model": options.model,
        "messages": [{"role": "user", "content": title_prompt}],
        "temperature": 0.2,
        "max_tokens": 32,
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut request_builder = client
        .post(&url)
        .header("Content-Type", "application/json");

    if let Some(ref key) = api_key {
        if !key.is_empty() {
            request_builder =
                request_builder.header("Authorization", format!("Bearer {}", key));
        }
    }

    let response = request_builder
        .body(request_body.to_string())
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                format!("Failed to connect to API at '{}'. Make sure the server is running.", endpoint)
            } else if e.is_timeout() {
                "Title generation timed out after 15 seconds.".to_string()
            } else {
                format!("HTTP request error: {}", e)
            }
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(format!("API returned error {}: {}", status, error_text));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse API response: {}", e))?;

    let raw = body["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let title = post_process_title(&raw, trimmed, min_words, max_words);
    Ok(TitleGenerateResult {
        title,
        used_device: "api".to_string(),
    })
}

fn post_process_title(raw: &str, prompt: &str, min_words: u32, max_words: u32) -> String {
    let cleaned = raw
        .replace("Title:", "")
        .replace("title:", "")
        .replace('"', "")
        .replace('\'', "")
        .replace('\n', " ")
        .replace('\r', " ")
        .trim()
        .to_string();

    if cleaned.is_empty() {
        return heuristic_title(prompt, min_words, max_words);
    }

    let mut words: Vec<&str> = cleaned.split_whitespace().collect();
    let min_take = min_words.max(1) as usize;
    let max_take = max_words.max(min_words.max(1)) as usize;

    if words.len() > max_take {
        words.truncate(max_take);
    }
    if words.len() < min_take {
        return heuristic_title(prompt, min_words, max_words);
    }

    let mut title = words.join(" ");
    if let Some((end, _)) = title.char_indices().nth(80) {
        title.truncate(end);
    }
    title.trim().to_string()
}

fn heuristic_title(prompt: &str, min_words: u32, max_words: u32) -> String {
    let first_line = prompt.lines().next().unwrap_or(prompt).trim();
    let cleaned = first_line
        .chars()
        .map(|c| if c.is_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect::<String>();
    let mut words: Vec<&str> = cleaned.split_whitespace().collect();
    if words.is_empty() {
        return "New Terminal".to_string();
    }

    let max_take = max_words.max(1) as usize;
    if words.len() > max_take {
        words.truncate(max_take);
    }

    let min_take = min_words.max(1) as usize;
    if words.len() < min_take {
        // Pad with existing words if too short
        let last = words.last().copied().unwrap_or("Task");
        while words.len() < min_take {
            words.push(last);
        }
    }

    words.join(" ")
}
