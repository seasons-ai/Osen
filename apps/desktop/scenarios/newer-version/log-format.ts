// Diagnostic one-line copy of a notification body for the stand's console status; the notification itself is not changed.
export const oneLine = (body: string): string => body.replace(/\r\n|\r|\n/g, " · ");
