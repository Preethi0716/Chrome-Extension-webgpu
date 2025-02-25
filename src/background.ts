import {
  ChatCompletionMessageParam,
  CreateExtensionServiceWorkerMLCEngine,
  MLCEngineInterface,
  ExtensionServiceWorkerMLCEngineHandler,
  CreateMLCEngine
} from "@mlc-ai/web-llm";

let handler: ExtensionServiceWorkerMLCEngineHandler | undefined;
let userToken: string | null = null;
let engine: MLCEngineInterface | null = null;
const chatHistory: ChatCompletionMessageParam[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_EMAIL_CONTENT_LENGTH = 4096; 
let popupActive = false;  // Global flag: true if popup is connected

interface PaymentData {
  "Due Date": string;
  "Total Amount Due": string;
  "Bank Name": string;
}

interface PaymentSummary {
  id: number; // IndexedDB key
  paymentDueDate: string;
  totalAmountDue: string;
  paymentStatus: string;
  summaryTimestamp: string;
  BankName: string;
}

// ----------------------
// Auth and Utility Functions
// ----------------------
async function getAuthToken(interactive = false): Promise<string | null> {
  return new Promise((resolve) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        console.error("❌ Authentication failed:", chrome.runtime.lastError?.message);
        resolve(null);
      } else {
        resolve(token);
      }
    });
  });
}

async function getUserEmail(token: string): Promise<string | null> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(response.statusText);
    const userData = await response.json();
    return userData.email;
  } catch (error) {
    console.error("❌ Failed to fetch user email:", error);
    return null;
  }
}

function decodeBase64(encoded: string): string {
  try {
    return atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch (error) {
    console.warn("⚠️ Error decoding Base64:", error);
    return "";
  }
}

function normalizeCurrencySymbols(text: string): string {
  return text.replace(/â\x82¹/g, "₹");
}

// ----------------------
// Email Processing Functions
// ----------------------
function extractEmailBody(payload: any): string {
  if (!payload) return "No body found";
  if (payload.mimeType === "text/plain" || payload.mimeType === "text/html") {
    if (payload.body?.data) {
      return decodeBase64(payload.body.data);
    }
  }
  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      console.log("Processing part with MIME type:", part.mimeType);
      if (part.mimeType === "text/plain" || part.mimeType === "text/html") {
        if (part.body?.data) {
          return decodeBase64(part.body.data);
        }
      } else if (part.mimeType && part.mimeType.startsWith("multipart/")) {
        const innerBody = extractEmailBody(part);
        if (innerBody && innerBody !== "No body found" && innerBody !== "No readable content") {
          return innerBody;
        }
      }
    }
  }
  if (payload.body?.data) {
    return decodeBase64(payload.body.data);
  }
  return "No readable content";
}

async function fetchEmailDetails(messageId: string) {
  try {
    if (!userToken) return null;
    const response = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!response.ok) throw new Error(response.statusText);
    const emailDetails = await response.json();
    const headers = emailDetails.payload?.headers || [];
    const payload = emailDetails.payload || {};
    let subject = "Unknown";
    let sender = "Unknown";
    for (const header of headers) {
      if (header.name === "Subject") subject = header.value;
      if (header.name === "From") sender = header.value;
    }
    const emailBody = extractEmailBody(payload);
    console.log(`📨 From: ${sender}\n📌 Subject: ${subject}\n📝 Body:\n${emailBody.substring(0, 10000)}...\n`);
    return { subject, content: emailBody, sender };
  } catch (error) {
    console.error("❌ Failed to fetch email details:", error);
    return null;
  }
}

function parseBankSummary(emailText: string): Record<string, string> {
  const markerRegex = /summary[\s:]*\n*/i;
  const markerMatch = emailText.match(markerRegex);
  if (!markerMatch) {
    console.warn("Summary marker not found.");
    return {};
  }
  const startIndex = markerMatch.index! + markerMatch[0].length;
  let summaryPart = emailText.substring(startIndex).trim();
  const noteIndex = summaryPart.search(/\bnote\b/i);
  if (noteIndex !== -1) {
    summaryPart = summaryPart.substring(0, noteIndex).trim();
  }
  const lines = summaryPart.split("\n").map(line => line.trim()).filter(line => line.length > 0);
  const expectedKeys: { pattern: RegExp; key: string }[] = [
    { pattern: /total amount due/i, key: "Total Amount Due" },
    { pattern: /rewards earned/i, key: "Rewards Earned" },
    { pattern: /payment due date|bill due date/i, key: "Payment Due Date" },
  ];
  const summary: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const expected = expectedKeys.find(exp => exp.pattern.test(line));
    if (expected) {
      let value = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].length > 0) {
          value = lines[j];
          i = j;
          break;
        }
      }
      summary[expected.key] = normalizeCurrencySymbols(value);
    }
  }
  return summary;
}

// ----------------------
// Model and Summarization Functions
// ----------------------
async function waitForEngine() {
  let attempts = 0;
  while (!engine && attempts < 10) {
    console.log(`🔄 Waiting for engine... Attempt ${attempts + 1}`);
    await sleep(1000);
    attempts++;
  }
  if (!engine) {
    console.warn("⚠️ Engine still not ready. Retrying initialization...");
    await initializeEngine();
  }
  if (!engine) {
    console.error("❌ Engine failed to initialize.");
  } else {
    console.log("🚀 Engine is ready!");
  }
}

async function initializeEngine() {
  if (engine) {
    console.log("Engine already loaded; reusing existing engine.");
    return;
  }
  try {
    console.log("🔄 Loading model...");
    engine = await CreateMLCEngine("Qwen2-0.5B-Instruct-q4f16_1-MLC");
    console.log("✅ Model loaded successfully");
  } catch (error) {
    console.error("❌ Error loading model:", error);
  }
}

// ----------------------
// Email Summarization
// ----------------------
// If valid emails are found, if the popup is active, forward the first valid email to the popup for processing;
// otherwise, process the email in the background.
async function checkEmails() {
  try {
    userToken = await getAuthToken(true);
    if (!userToken) return;
    const userEmail = await getUserEmail(userToken);
    if (!userEmail) return;
    console.log("📩 Checking emails for:", userEmail);
    const keywords = ["Due Date", "Amount", "Credit Card", "Statement"];
    const query = keywords.map(kw => `"${kw}"`).join(" OR ");
    console.log(`🔍 Searching emails with query: ${query}`);
    const response = await fetch(`https://www.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=5`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!response.ok) throw new Error(response.statusText);
    const emailData = await response.json();
    if (emailData.messages?.length > 0) {
      console.log(`✅ Found ${emailData.messages.length} potentially relevant email(s)`);
      let validEmails: { subject: string; content: string; sender: string }[] = [];
      for (let i = 0; i < emailData.messages.length; i++) {
        console.log(`🔄 Processing email ${i + 1} of ${emailData.messages.length}...`);
        const emailDetails = await fetchEmailDetails(emailData.messages[i].id);
        if (!emailDetails) continue;
        const { subject, content, sender } = emailDetails;
        const emailText = `${subject} ${content}`.toLowerCase();
        const containsAllKeywords = keywords.every(kw => emailText.includes(kw.toLowerCase()));
        if (containsAllKeywords) {
          console.log("✅ Email meets all keyword criteria!");
          validEmails.push({ subject, content, sender });
        } else {
          console.log("❌ Email does NOT contain all required keywords, skipping...");
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (validEmails.length === 0) {
        console.log("📭 No emails met all keyword criteria.");
      } else {
        console.log(`📨 ${validEmails.length} emails matched all keywords!`);
        if (popupActive) {
          console.log("Popup is active; forwarding first valid email to popup for model processing.");
          waitForEngine()
          chrome.runtime.sendMessage({ type: "processEmailInPopup", content: validEmails[0].content }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn("Error sending message to popup:", chrome.runtime.lastError.message);
              console.log("Processing email in background as fallback.");
              summarizeEmail(validEmails[0].content);
            }
          });
        } else {
          console.log("Processing email in background.");
          summarizeEmail(validEmails[0].content);
        }
      }
    } else {
      console.log("📭 No relevant emails found.");
    }
  } catch (error) {
    console.error("❌ Error in checkEmails:", error);
  }
}

// Process email content and summarize it (in the background).
async function summarizeEmail(emailContent: string) {
  if (!engine) {
    console.warn("⏳ Engine is not initialized. Waiting...");
    await waitForEngine();
  }
  if (!engine) {
    console.error("❌ Engine failed to initialize.");
    return;
  }
  console.log("🔍 (Background) Sending email for summarization...");
  let truncatedEmailContent = emailContent;
  if (emailContent.length > MAX_EMAIL_CONTENT_LENGTH) {
    truncatedEmailContent = emailContent.substring(0, MAX_EMAIL_CONTENT_LENGTH);
    console.log(`Email content truncated to ${MAX_EMAIL_CONTENT_LENGTH} characters.`);
  }
  console.log("Full email content (truncated if needed):", truncatedEmailContent);
  truncatedEmailContent = truncatedEmailContent.toLowerCase();
  const summaryDict = parseBankSummary(emailContent);
  console.log("Structured Summary:", summaryDict);
  emailContent = emailContent.toLowerCase();
  chatHistory.length = 0; // Clear previous history
  const prompt = `
    Extract the following from the inputs provided:

    1. From the email below, extract only the bank name and cardholder name from the email content "${truncatedEmailContent}". 
    2. From the dictionary below, extract only the Payment Due Date and Total Amount Due from Dictionary: ${JSON.stringify(summaryDict)}. 
    Combine the results from 1 and 2 and return it as JSON in the following format:
    {
      "Due Date": "DD-MM-YYYY",
      "Total Amount Due": "XXXX.XX",
      "Bank Name": "XXXX",
      "Card Holder Name": "XXXX"
    }`;
  chatHistory.push({ role: "user", content: prompt });
  try {
    const completion = await engine.chat.completions.create({ stream: true, messages: chatHistory });
    let curMessage = "";
    console.log("📜 Processing AI response...");
    for await (const chunk of completion) {
      const curDelta = chunk.choices[0]?.delta?.content;
      if (curDelta) {
        curMessage += curDelta;
      }
    }
    console.log("AI response:", curMessage);

    console.log("Summarization result:", curMessage);
    const jsonResponse = curMessage.split("This JSON format is provided for you")[0].trim();
    let paymentData: PaymentData;
    try {
      paymentData = JSON.parse(jsonResponse);
    } catch (error) {
      console.error("❌ Error parsing AI response:", error);
      return;
    }
    savePaymentSummaryToIndexedDB({
      "Due Date": paymentData["Due Date"],
      "Total Amount Due": paymentData["Total Amount Due"],
      "Bank Name": paymentData["Bank Name"]
    });

    sendNotifications();
  } catch (error) {
    console.error("❌ Error summarizing email:", error);
  }
}

// ----------------------
// IndexedDB and Notification Functions
// ----------------------
function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("PaymentSummariesDB", 1);
    request.onupgradeneeded = function(event: IDBVersionChangeEvent) {
      const db = (event.target as IDBRequest).result;
      if (db) {
        if (!db.objectStoreNames.contains("summaries")) {
          db.createObjectStore("summaries", { keyPath: "id", autoIncrement: true });
        }
        console.log("✅ Object store 'summaries' created.");
      } else {
        console.error("❌ Unable to access the database during upgrade.");
      }
    };
    request.onerror = function() {
      reject("Error opening IndexedDB");
    };
    request.onsuccess = function(event) {
      const db = (event.target as IDBRequest).result;
      resolve(db);
      console.log("✅ Database opened successfully.");
    };
  });
}

function getPaymentSummariesFromIndexedDB(): Promise<PaymentSummary[]> {
  return new Promise((resolve, reject) => {
    openDatabase().then((db) => {
      const transaction = db.transaction("summaries", "readonly");
      const store = transaction.objectStore("summaries");
      const request = store.getAll();
      request.onsuccess = function() {
        resolve(request.result);
      };
      request.onerror = function() {
        reject("Error retrieving payment summaries from IndexedDB");
      };
    }).catch(reject);
  });
}

function savePaymentSummaryToIndexedDB(paymentData: any) {
  openDatabase().then((db) => {
    const transaction = db.transaction("summaries", "readwrite");
    const store = transaction.objectStore("summaries");
    const summary = {
      DueDate: paymentData["Due Date"],
      totalAmountDue: paymentData["Total Amount Due"],
      BankName: paymentData["Bank Name"],
      paymentStatus: "unpaid",
      summaryTimestamp: new Date().toISOString(),
    };
    store.add(summary);
    console.log("✅ Payment summary saved to IndexedDB.");
  }).catch(err => {
    console.error("❌ Error saving summary to IndexedDB:", err);
  });
}

function sendNotifications() {
  getPaymentSummariesFromIndexedDB()
    .then((paymentSummaries: PaymentSummary[]) => {
      if (paymentSummaries.length > 0) {
        paymentSummaries.forEach((summary) => {
          const message = `Payment Due Date: ${summary.paymentDueDate}, Total Amount Due: ${summary.totalAmountDue}, Status: ${summary.paymentStatus}`;
          console.log("🔍 Sending notification for:", summary);
          sendNotification("Payment Summary", message);
        });
      } else {
        console.log("⚠️ No payment summaries found in IndexedDB");
        sendNotification("No Payment Summary", "No payment summary found in IndexedDB.");
      }
    })
    .catch(err => {
      console.error("❌ Error retrieving payment summaries from IndexedDB:", err);
      sendNotification("Error", "An error occurred while retrieving payment summaries.");
    });
}

function sendNotification(title: string, message: string) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon-27.53632084.png',
    title: title,
    message: message,
    priority: 2
  });
}

// ----------------------
// Event Listeners and Alarms
// ----------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getEmailData") {
    checkEmails();
  }
  // For processing emails in popup.
  if (message.type === "processEmailInPopup") {
    console.log("Received processEmailInPopup message from popup.");
    sendResponse({ success: true });
  }
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  console.log("🔗 Port connected:", port.name);
  if (port.name === "web_llm_service_worker") {
    popupActive = true;
    if (!handler) {
      console.log("🛠️ Initializing new MLCEngineHandler...");
      handler = new ExtensionServiceWorkerMLCEngineHandler(port);
    } else {
      console.log("🔄 Reusing existing handler...");
      handler.setPort(port);
    }
    port.onMessage.addListener(handler.onmessage.bind(handler));
    port.onDisconnect.addListener(() => {
      console.warn("⚠️ Popup disconnected, resetting handler...");
      handler = undefined;
      popupActive = false;
    });
    // Automatically check emails when the popup connects.
    checkEmails();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension Installed - Setting up alarms and initializing engine.");
  initializeEngine().then(() => checkEmails());
  chrome.alarms.create("keepAlive", { periodInMinutes: 3 });
  chrome.alarms.create("checkEmails", { periodInMinutes: 3 });
  chrome.alarms.create("sendNotifications", { periodInMinutes: 5 });
});

chrome.runtime.onStartup.addListener(() => {
  console.log("Service worker started - initializing engine and checking emails.");
  initializeEngine().then(() => checkEmails());
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "checkEmails") {
    console.log("Alarm triggered: checkEmails");
    checkEmails();
  }
  if (alarm.name === "sendNotifications") {
    console.log("Alarm triggered: sendNotifications");
    checkEmails();
  }
  if (alarm.name === "keepAlive") {
    console.log("Keep Alive Alarm Triggered");
    chrome.runtime.getPlatformInfo((info) => {
      console.log("Service worker is still active. Platform:", info.os);
    });
  }
});

const keepAlive = () => setInterval(chrome.runtime.getPlatformInfo, 20e3);
chrome.runtime.onStartup.addListener(keepAlive);
keepAlive();
