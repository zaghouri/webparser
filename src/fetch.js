import axios from "axios";
import { SOURCE_BASE_URL } from "./config.js";

const TIMEOUT_MS = 15_000;
const MAX_RETRIES = 2;
const DELAY_MIN_MS = 200;
const DELAY_MAX_MS = 300;

function randomDelayMs() {
  return (
    DELAY_MIN_MS +
    Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1))
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(error) {
  if (!error.response) return true;
  const status = error.response.status;
  return status >= 500 || status === 429;
}

/**
 * GET with delay before request, 15s timeout, up to 2 retries on transient failures.
 */
export async function fetchText(url, { responseType = "text" } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await sleep(randomDelayMs());
    try {
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        responseType,
        validateStatus: (s) => s >= 200 && s < 300,
        headers: {
          "User-Agent":
            `Mozilla/5.0 (compatible; WebParser/1.0; +${SOURCE_BASE_URL}/)`,
        },
      });
      return typeof res.data === "string" ? res.data : String(res.data);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES && shouldRetry(err)) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

export async function fetchXML(url) {
  return fetchText(url, { responseType: "text" });
}

export async function fetchHtml(url) {
  return fetchText(url, { responseType: "text" });
}
