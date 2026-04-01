import axios from "axios";
import {
  WC_BASE_URL,
  WC_CONSUMER_KEY,
  WC_CONSUMER_SECRET,
} from "./config.js";

const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;
const DELAY_MIN_MS = 200;
const DELAY_MAX_MS = 350;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  return (
    DELAY_MIN_MS +
    Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS + 1))
  );
}

function shouldRetry(error) {
  if (!error?.response) return true;
  const status = error.response.status;
  return status >= 500 || status === 429;
}

export function createWooClientFromEnv() {
  const baseUrl = WC_BASE_URL;
  const consumerKey = WC_CONSUMER_KEY;
  const consumerSecret = WC_CONSUMER_SECRET;

  if (!baseUrl || !consumerKey || !consumerSecret) {
    throw new Error(
      "Missing WooCommerce credentials. Set WC_BASE_URL, WC_CONSUMER_KEY, WC_CONSUMER_SECRET."
    );
  }

  const api = axios.create({
    timeout: TIMEOUT_MS,
    auth: {
      username: consumerKey,
      password: consumerSecret,
    },
    validateStatus: (status) => status >= 200 && status < 300,
  });

  async function request(method, path, data = undefined, params = undefined) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await sleep(randomDelayMs());
      try {
        const response = await api.request({
          method,
          url: `${baseUrl}/wp-json/wc/v3${path}`,
          params,
          data,
        });
        return response.data;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES && shouldRetry(error)) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  return {
    get(path, params) {
      return request("GET", path, undefined, params);
    },
    post(path, data) {
      return request("POST", path, data, undefined);
    },
    put(path, data) {
      return request("PUT", path, data, undefined);
    },
  };
}
