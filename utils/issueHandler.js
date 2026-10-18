const logger = require("./logger");

// Verify reCAPTCHA token
async function verifyRecaptcha(token) {
  try {
    const response = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          secret: process.env.RECAPTCHA_SECRET_KEY || "",
          response: token || "",
        }).toString(),
      }
    );

    const data = await response.json();

    // For v3, we need to check both success and score
    if (!data.success) {
      logger.error("reCAPTCHA verification failed:", data["error-codes"]);
      return false;
    }

    // Check if the score is above our threshold (0.5 is a moderate threshold)
    if (data.score < 0.5) {
      logger.error("reCAPTCHA score too low:", data.score);
      return false;
    }

    // Check if the action matches what we expect
    if (data.action !== "submit_issue") {
      logger.error("reCAPTCHA action mismatch:", data.action);
      return false;
    }

    return true;
  } catch (error) {
    logger.error("reCAPTCHA verification error:", error);
    return false;
  }
}

// Create GitHub issue
async function createGitHubIssue(data) {
  const {
    feedbackType,
    title,
    deviceType,
    browserType,
    errorDetails,
    comments,
  } = data;

  // Log the received data
  logger.debug("Creating GitHub issue with data:", {
    feedbackType,
    title,
    deviceType,
    browserType,
    hasErrorDetails: !!errorDetails,
    hasComments: !!comments,
  });

  const isIssue = feedbackType === "issue";
  const issueTitle = isIssue
    ? `[Bug Report] ${title}`
    : `[Feature Request] ${title}`;

  let body = `## ${isIssue ? "Bug Report" : "Feature Request"}\n\n`;

  if (isIssue) {
    body += `**Device Type:** ${deviceType}`;
    if (deviceType === "web" && browserType) {
      body += ` (Browser: ${browserType})`;
    }
    body += "\n\n";
    if (errorDetails) {
      body += `**Error Details:**\n\`\`\`\n${errorDetails}\n\`\`\`\n\n`;
    }
  }

  body += `**Description:**\n${comments}\n\n`;
  body += `---\n*Submitted via Stremio AI Search Addon*`;

  try {
    const response = await fetch(
      "https://api.github.com/repos/itcon-pty-au/stremio-ai-search/issues",
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github.v3+json",
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: issueTitle,
          body,
          labels: [feedbackType],
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      logger.error("GitHub API error response:", errorData);
      throw new Error(`GitHub API error: ${response.status}`);
    }

    const result = await response.json();
    return result.html_url;
  } catch (error) {
    logger.error("GitHub issue creation error:", error);
    throw new Error("Failed to create GitHub issue");
  }
}

// Main handler function
async function handleIssueSubmission(data) {
  const { recaptchaToken } = data;

  // Verify reCAPTCHA
  const isValidCaptcha = await verifyRecaptcha(recaptchaToken);
  if (!isValidCaptcha) {
    throw new Error("Invalid reCAPTCHA verification");
  }

  // The configure page links to the new issue when issueUrl is present.
  const issueUrl = await createGitHubIssue(data);

  return { success: true, issueUrl };
}

module.exports = {
  handleIssueSubmission,
};
