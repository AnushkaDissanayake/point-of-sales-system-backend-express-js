function successResponse(res, data = null, message = 'Success') {
  // Matches Spring Boot: object fields spread flat, arrays stay as 'data', null omitted
  if (data === null || data === undefined) {
    return res.json({ status: 'SUCCESS', message });
  }
  if (Array.isArray(data)) {
    // Spring Boot returns arrays as the direct body — e.g. category/list returns [{...}, ...]
    // Frontend reads response.data which IS the array directly
    return res.json(data);
  }
  // Object: spread fields flat — e.g. { itemList: Page } becomes top-level fields
  return res.json({ status: 'SUCCESS', message, ...data });
}

function errorResponse(res, statusCode, errorCode, failReason) {
  return res.status(statusCode).json({ errorCode, failReason });
}

function setupCredentialsResponse(res, data = null) {
  return res.json({ status: 'SETUP_CREDENTIALS', message: 'Setup required', data });
}

module.exports = { successResponse, errorResponse, setupCredentialsResponse };
