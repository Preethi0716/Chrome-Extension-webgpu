"use strict";

import { CreateMLCEngine } from "@mlc-ai/web-llm";
import "./popup.css";
import {
  ChatCompletionMessageParam,
  CreateExtensionServiceWorkerMLCEngine,
  MLCEngineInterface,
} from "@mlc-ai/web-llm";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(" Initializing Popup...");

const MAX_EMAIL_CONTENT_LENGTH = 4096; 

let engine: MLCEngineInterface | null = null;
const chatHistory: ChatCompletionMessageParam[] = [];

// Initialize the model
async function initializeEngine() {
  try {
    console.log(" Loading model...");
    engine = await CreateMLCEngine(
      "Qwen2-0.5B-Instruct-q4f16_1-MLC"
    );
    console.log(" Model loaded successfully");
  } catch (error) {
    console.error(" Error loading model:", error);
  }
}

interface PaymentData {
  "Due Date": string;
  "Total Amount Due": string;
  "Bank Name": string;
}

interface PaymentSummary {
  DueDate: string;
  totalAmountDue: string;
  paymentStatus: string;
  BankName: string;
}


// Function to send Chrome Notification
function sendNotification(title: string, message: string) {
  console.log(" Sending notification:", title, message); 

  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon-27.53632084.png', 
    title: title,
    message: message,
    priority: 2
  }, (notificationId) => {
    if (chrome.runtime.lastError) {
      console.error(" Error creating notification:", chrome.runtime.lastError.message);
    } else {
      console.log( `Notification created with ID: ${notificationId}`);
    }
  });
}

// Open or create the IndexedDB database
function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("PaymentSummariesDB", 1);

    request.onupgradeneeded = function(event: IDBVersionChangeEvent) {
      const db = (event.target as IDBRequest).result;

      if (db) {
        if (!db.objectStoreNames.contains("summaries")) {
          db.createObjectStore("summaries", { keyPath: "id", autoIncrement: true });
        }
        console.log(" Object store 'summaries' created.");
      } else {
        console.error(" Unable to access the database during upgrade.");
      }
    };

    request.onerror = function() {
      reject("Error opening IndexedDB");
    };

    request.onsuccess = function(event) {
      const db = (event.target as IDBRequest).result;
      resolve(db);
      console.log(" Database opened successfully.");
    };
  });
}

// Save payment summary to IndexedDB
function savePaymentSummaryToIndexedDB(paymentData: any) {
  openDatabase().then((db) => {
    const transaction = db.transaction("summaries", "readwrite");
    const store = transaction.objectStore("summaries");

    // Normalize the new data for comparison.
    const newTotal = paymentData["Total Amount Due"].replace(/[,]/g, '');
    const newDue = paymentData["Due Date"];

    const getAllRequest = store.getAll();
    getAllRequest.onsuccess = function() {
      const existingSummaries: PaymentSummary[] = getAllRequest.result;
      const isDuplicate = existingSummaries.some(summary => {
        const existingTotal = summary.totalAmountDue.replace(/[,]/g, '');
        const existingDue = summary.DueDate;
        return existingTotal === newTotal && existingDue === newDue;
      });
      if (!isDuplicate) {
        const summary = {
          DueDate: newDue,
          totalAmountDue: newTotal,
          BankName: paymentData["Bank Name"].trim(),
          paymentStatus: "unpaid",
          summaryTimestamp: new Date().toISOString(),
        };
        store.add(summary);
        console.log(" Payment summary saved to IndexedDB.");
      } else {
        console.log("Duplicate summary found. Not saving.");
      } 
    };
    getAllRequest.onerror = function() {
      console.error(" Error checking for duplicate summaries in IndexedDB.");
    };
  }).catch(err => {
    console.error(" Error saving summary to IndexedDB:", err);
  });
}


// Retrieve payment summaries from IndexedDB
function getPaymentSummariesFromIndexedDB(): Promise<PaymentSummary[]> {
  return new Promise((resolve, reject) => {
    openDatabase().then((db) => {
      const transaction = db.transaction("summaries", "readonly");
      const store = transaction.objectStore("summaries");
      const request = store.getAll();

      request.onsuccess = function() {
        resolve(request.result); // TypeScript now knows the type is PaymentSummary[]
      };

      request.onerror = function() {
        reject("Error retrieving payment summaries from IndexedDB");
      };
    }).catch(reject);
  });
}

// Update the UI with the extracted payment details
function updateAnswer(summary: string) {
  const answerWrapper = document.getElementById("answerWrapper");
  const answerElement = document.getElementById("answer");
  const loadingIndicator = document.getElementById("loading-indicator");
  const timestampElement = document.getElementById("timestamp");

  if (!answerWrapper || !answerElement || !loadingIndicator || !timestampElement) {
    console.error(" Missing required DOM elements in updateAnswer()");
    return;
  }

  answerWrapper.style.display = "block";
  answerElement.innerHTML = summary.replace(/\n/g, "<br>");
  loadingIndicator.style.display = "none";

  timestampElement.innerText = `Updated: ${new Date().toLocaleString()}`;
}


function normalizeCurrencySymbols(text: string): string {
  // Replace garbled rupee symbol with the proper one.
  return text.replace(/â\x82¹/g, "₹");
}

function parseBankSummary(emailText: string): Record<string, string> {
  // Use a regex to locate a common "summary" marker.
  const markerRegex = /summary[\s:]*\n*/i;
  const markerMatch = emailText.match(markerRegex);
  if (!markerMatch) {
    console.warn("Summary marker not found.");
    return {};
  }
  
  // Extract text after the marker.
  const startIndex = markerMatch.index! + markerMatch[0].length;
  let summaryPart = emailText.substring(startIndex).trim();
  
  // If there's a "Note:" section later, cut it off.
  const noteIndex = summaryPart.search(/\bnote\b/i);
  if (noteIndex !== -1) {
    summaryPart = summaryPart.substring(0, noteIndex).trim();
  }
  
  // Split the summary section into lines and filter out empty lines.
  const lines = summaryPart.split("\n").map(line => line.trim()).filter(line => line.length > 0);
  
  // Define our expected keys (case-insensitive) and their normalized names.
  const expectedKeys: { pattern: RegExp; key: string }[] = [
    { pattern: /total amount due/i, key: "Total Amount Due" },
    { pattern: /rewards earned/i, key: "Rewards Earned" },
    { pattern: /payment due date|bill due date/i, key: "Payment Due Date" },
  ];
  
  const summary: Record<string, string> = {};
  
  // Iterate over the lines, and if a line matches one of the expected keys, 
  // take the next non-empty line as the value.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const expected = expectedKeys.find(exp => exp.pattern.test(line));
    if (expected) {
      // Get the next non-empty line as value.
      let value = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].length > 0) {
          value = lines[j];
          i = j; // advance i past the value line
          break;
        }
      }
      summary[expected.key] = normalizeCurrencySymbols(value);
      // summary[expected.key] = value;
    }
  }
  
  return summary;
}


// Function to process email content and summarize it
async function summarizeEmail(emailContent: string) {
  if (!engine) {
    console.warn(" Engine is not initialized. Waiting...");
    await waitForEngine();
  }

  if (!engine) {
    console.error(" Engine failed to initialize.");
    updateAnswer(" Unable to process email.");
    return;
  }

  console.log(" Sending email for summarization...");


  let truncatedEmailContent = emailContent;
  if (emailContent.length > MAX_EMAIL_CONTENT_LENGTH) {
    truncatedEmailContent = emailContent.substring(0, MAX_EMAIL_CONTENT_LENGTH);
    console.log(`Email content truncated to ${MAX_EMAIL_CONTENT_LENGTH} characters.`);
  }

  console.log("Full email content (truncated if needed):", truncatedEmailContent);

  // Lowercase the email content for prompt consistency
  truncatedEmailContent = truncatedEmailContent.toLowerCase();

  // // Format the email content as JSON
  // const emailJson = structureEmailData(emailContent)

  // console.log("email content: ", emailJson)

  console.log(JSON.stringify(truncatedEmailContent))

  const summaryDict = parseBankSummary(emailContent);
  console.log("Structured Summary:", summaryDict);

  emailContent = emailContent.toLowerCase()
  
  const prompt = `
    Extract the following from the inputs provided:

    1. From the email below, extract only the bank name from the email content "${truncatedEmailContent}". 
    
    2. From the dictionary below, extract only the Payment Due Date and Total Amount Due from Dictionary: ${JSON.stringify(summaryDict)}. 

    combine both 1 and 2 answers and return it as JSON in the following format:
      {
      "Due Date": "DD-MM-YYYY",
      "Total Amount Due": "XXXX.XX",
      "Bank Name": "XXXX",
    }`;

    chatHistory.length = 0; 

    chatHistory.push({ role: "user", content: prompt });

  try {
    const completion = await engine.chat.completions.create({ stream: true, messages: chatHistory });
    let curMessage = "";


    console.log(" Processing AI response...");
    for await (const chunk of completion) {
      const curDelta = chunk.choices[0]?.delta?.content;
      if (curDelta) {
        curMessage += curDelta;
      }
    }
    
    // chatHistory.push({ role: "assistant", content: curMessage });

    console.log("AI response:",curMessage);

    updateAnswer(curMessage);
    
    // Trim any unwanted text from the response (e.g., "This JSON format is provided for you...")
    const jsonResponse = curMessage.split("This JSON format is provided for you")[0].trim();

    let paymentData: PaymentData;

    try {
      paymentData = JSON.parse(jsonResponse);
    } catch (error) {
      console.error(" Error parsing AI response:", error);
      return;
    }

    // Save summarized result to IndexedDB
    savePaymentSummaryToIndexedDB({
      "Due Date": paymentData["Due Date"],
      "Total Amount Due": paymentData["Total Amount Due"],
      "Bank Name": paymentData["Bank Name"]
    });


    // const notificationMessage = `Payment Due Date: ${paymentData["Due Date"]}, Total Amount Due: ${paymentData["Total Amount Due"]}, Status: unpaid`;
    // console.log(" Sending notification:", notificationMessage); 

    // chrome.runtime.sendMessage({
    //   type: "sendNotification",
    //   message: notificationMessage
    // });

    notifyFromIndexedDB() 

  } catch (error) {
    console.error(" Error summarizing email:", error);
  }
}

// Handle incoming email data from the background script
chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
  try {
    if (message.type === "emailData") {
      console.log(" Received Email Data:", message.emails);

      if (!message.emails || message.emails.length === 0) {
        console.warn(" No valid emails received.");
        sendResponse({ success: false, message: "No valid emails found" });
        return;
      }
  
      const email = message.emails[0]; // Take the first valid email
      console.log(" Processing Email:", email);
  
      if (!engine) {
        console.warn(" Engine not initialized. Waiting...");
        await waitForEngine();
      }

      if (engine) {
        await summarizeEmail(message.emails[0]?.content);
        sendResponse({ success: true, message: "Email processed successfully" });
      } else {
        console.error(" Engine failed to initialize.");
        sendResponse({ success: false, message: "Engine failed to initialize" });
      }
    }
  } catch (error) {
    console.error(" Message processing error:", error);
    sendResponse({ success: false, message: "Unexpected error occurred" });
  }

  return true; 
});

// Wait for engine initialization
async function waitForEngine() {
  let attempts = 0;
  while (!engine && attempts < 10) {
    console.log(` Waiting for engine... Attempt ${attempts + 1}`);
    await sleep(1000);
    attempts++;
  }

  if (!engine) {
    console.warn(" Engine still not ready. Retrying initialization...");
    await initializeEngine(); // 🔥 Try initializing again
  }

  if (!engine) {
    console.error(" Engine failed to initialize.");
  } else {
    console.log(" Engine is ready!");
  }
}


// Wait for DOM before initializing
document.addEventListener("DOMContentLoaded", async () => {
  console.log(" DOM loaded, initializing engine...");
  await initializeEngine();
  
});

// Send a notification with payment details from IndexedDB
function notifyFromIndexedDB() {
  getPaymentSummariesFromIndexedDB().then((paymentSummaries: PaymentSummary[]) => {
    if (paymentSummaries.length > 0) {
      const latestSummary = paymentSummaries[paymentSummaries.length - 1]; // Get the latest payment summary
      const message = `Payment Due Date: ${latestSummary.DueDate}, Total Amount Due: ${latestSummary.totalAmountDue}, Status: ${latestSummary.paymentStatus}`;
      console.log(" Payment summary found in IndexedDB:", latestSummary); 
      sendNotification("Payment Summary", message);
    } else {
      console.log(" No payment summaries found in IndexedDB");
      sendNotification("No Payment Summary", "No payment summary found in IndexedDB.");
    }
  }).catch(err => {
    console.error(" Error retrieving payment summaries from IndexedDB:", err);
    sendNotification("Error", "An error occurred while retrieving payment summaries.");
  });
}


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "processEmailInPopup") {
    console.log("Popup received email for processing:", message.content);
    // Call your popup summarization function here:
    summarizeEmail(message.content);
    sendResponse({ success: true });
  }
  return true;
});
