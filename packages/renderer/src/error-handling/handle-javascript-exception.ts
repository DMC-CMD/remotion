import {CDPSession, Page, Protocol} from 'puppeteer-core';
import {Internals} from 'remotion';
import {UnsymbolicatedStackFrame} from '../parse-browser-error-stack';
import {SymbolicatedStackFrame} from '../symbolicate-stacktrace';
import {SymbolicateableError} from './symbolicateable-error';

export class ErrorWithStackFrame extends Error {
	symbolicatedStackFrames: SymbolicatedStackFrame[] | null;
	frame: number | null;
	name: string;
	delayRenderCall: SymbolicatedStackFrame[] | null;

	constructor({
		message,
		symbolicatedStackFrames,
		frame,
		name,
		delayRenderCall,
	}: {
		message: string;
		symbolicatedStackFrames: SymbolicatedStackFrame[] | null;
		frame: number | null;
		name: string;
		delayRenderCall: SymbolicatedStackFrame[] | null;
	}) {
		super(message);
		this.symbolicatedStackFrames = symbolicatedStackFrames;
		this.frame = frame;
		this.name = name;
		this.delayRenderCall = delayRenderCall;
	}
}

const cleanUpErrorMessage = (
	exception: Protocol.Runtime.ExceptionThrownEvent
) => {
	let errorMessage = exception.exceptionDetails.exception
		?.description as string;
	const errorType = exception.exceptionDetails.exception?.className as string;
	const prefix = `${errorType}: `;

	if (errorMessage.startsWith(prefix)) {
		errorMessage = errorMessage.substring(prefix.length);
	}

	const frames = exception.exceptionDetails.stackTrace?.callFrames.length ?? 0;
	const split = errorMessage.split('\n');
	return split.slice(0, Math.max(1, split.length - frames)).join('\n');
};

const removeDelayRenderStack = (message: string) => {
	const index = message.indexOf(Internals.DELAY_RENDER_CALLSTACK_TOKEN);
	if (index === -1) {
		return message;
	}

	return message.substring(0, index);
};

const callFrameToStackFrame = (
	callFrame: Protocol.Runtime.CallFrame
): UnsymbolicatedStackFrame => {
	return {
		columnNumber: callFrame.columnNumber,
		fileName: callFrame.url,
		functionName: callFrame.functionName,
		lineNumber: callFrame.lineNumber,
	};
};

export const handleJavascriptException = ({
	page,
	onError,
	frame,
}: {
	page: Page;
	frame: number | null;
	onError: (err: Error) => void;
}) => {
	const client = (page as unknown as {_client: CDPSession})._client;

	const handler = async (exception: Protocol.Runtime.ExceptionThrownEvent) => {
		const rawErrorMessage = exception.exceptionDetails.exception
			?.description as string;
		const cleanErrorMessage = cleanUpErrorMessage(exception);
		if (!exception.exceptionDetails.stackTrace) {
			const err = new Error(removeDelayRenderStack(cleanErrorMessage));
			err.stack = rawErrorMessage;
			onError(err);
			return;
		}

		const errorType = exception.exceptionDetails.exception?.className as string;

		const symbolicatedErr = new SymbolicateableError({
			message: removeDelayRenderStack(cleanErrorMessage),
			stackFrame: (
				exception.exceptionDetails.stackTrace
					.callFrames as Protocol.Runtime.CallFrame[]
			).map((f) => callFrameToStackFrame(f)),
			frame,
			name: errorType,
			stack: exception.exceptionDetails.exception?.description,
		});
		onError(symbolicatedErr);
	};

	client.on('Runtime.exceptionThrown', handler);

	return () => {
		client.off('Runtime.exceptionThrown', handler);
	};
};
