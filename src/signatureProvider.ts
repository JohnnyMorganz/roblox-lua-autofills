// Roblox Signature Provider
// Provides parameter information to service/ methods, DataType methods and anonymous functions provided to events
// Based off vscode/typescript-language-features, licensed under MIT
// https://github.com/microsoft/vscode/blob/master/extensions/typescript-language-features/src/features/signatureHelp.ts

import * as vscode from "vscode"
import { AutocompleteParameter, getAutocompleteDump } from "./autocompleteDump"
import { ApiFunction, ApiParameter, getApiDump } from "./dump"
import { createDocumentationString, createParameterLabel, createStructParameterLabel, inferType } from "./utils"

const PARAMETER_SEPERATOR = ", "

interface ClassSignatureInformations {
    [memberName: string]: vscode.SignatureInformation[]
}

const isApiParameter = (variable: ApiParameter | AutocompleteParameter): variable is ApiParameter =>
    (variable as ApiParameter).Name !== undefined

const parameterizeSignature = (
        signature: vscode.SignatureInformation,
        parameters: ApiParameter[] | AutocompleteParameter[],
    ): vscode.SignatureInformation => {

    let index = signature.label.length
    for (const parameterIndex in parameters) {
        if (parameters[parameterIndex]) {
            const parameter = parameters[parameterIndex]
            const parameterLabel =
                isApiParameter(parameter) ? createParameterLabel(parameter) : createStructParameterLabel(parameter)
            signature.parameters.push(
                new vscode.ParameterInformation(
                    [index, index + parameterLabel.length],
                    // TODO: Documentation?
                ),
            )
            index += parameterLabel.length
            signature.label += parameterLabel

            // Add in sepeartor if not reached the end
            if (Number(parameterIndex) !== parameters.length - 1) {
                signature.label += PARAMETER_SEPERATOR
                index += PARAMETER_SEPERATOR.length
            }
        }
    }

    return signature
}

export class RobloxSignatureProvider implements vscode.SignatureHelpProvider {
    private classHelpers: Promise<Array<Map<string, ClassSignatureInformations>>>
    private structHelpers: Promise<Array<Map<string, ClassSignatureInformations>>>

    constructor() {
        this.classHelpers = (async () => {
            const functionHelpers = new Map<string, ClassSignatureInformations>()
            const eventHelpers = new Map<string, ClassSignatureInformations>()

            const classes = (await getApiDump()).Classes
            for (const klass of classes) {
                // Sort Functions
                const callableMembers = klass.Members.filter(
                    member => member.MemberType === "Function") as ApiFunction[]

                const functionClassInformations: ClassSignatureInformations = {}

                for (const member of callableMembers) {
                    functionClassInformations[member.Name] = functionClassInformations[member.Name] || []

                    const signature = parameterizeSignature(
                        new vscode.SignatureInformation(`${member.Name}(`),
                        member.Parameters,
                    )

                    signature.label += `): ${member.ReturnType ? member.ReturnType.Name : "unknown"}`
                    signature.documentation = createDocumentationString(member, "Function", klass.Name)
                    functionClassInformations[member.Name].push(signature)
                }

                functionHelpers.set(klass.Name, functionClassInformations)

                // Sort Events
                const eventMembers = klass.Members.filter(
                    member => member.MemberType === "Event") as ApiFunction[]

                const eventClassInformations: ClassSignatureInformations = {}

                for (const member of eventMembers) {
                    eventClassInformations[member.Name] = eventClassInformations[member.Name] || []

                    const signature = parameterizeSignature(
                        new vscode.SignatureInformation(`${member.Name}:Connect(`),
                        member.Parameters,
                    )
                    signature.label += ")"
                    signature.documentation = createDocumentationString(member, "Event", klass.Name)
                    eventClassInformations[member.Name].push(signature)
                }

                eventHelpers.set(klass.Name, eventClassInformations)
            }

            return [ functionHelpers, eventHelpers ]
        })()

        this.structHelpers = (async () => {
            const functionHelpers = new Map<string, ClassSignatureInformations>()

            const structs = (await getAutocompleteDump()).ItemStruct
            for (const struct of structs) {
                const functionClassInformations: ClassSignatureInformations = {}

                for (const member of struct.functions) {
                    functionClassInformations[member.name] = functionClassInformations[member.name] || []

                    const signature = parameterizeSignature(
                        new vscode.SignatureInformation(`${member.name}(`),
                        member.parameters,
                    )

                    signature.label += `): ${member.returns ? member.returns.map(ret => ret.type).join(", ") : "unknown"}`
                    signature.documentation = new vscode.MarkdownString(`${member.description ? member.description + "\n\n" : ""}[Developer Reference](https://developer.roblox.com/en-us/api-reference/datatype/${struct.name})`)
                    functionClassInformations[member.name].push(signature)
                }

                functionHelpers.set(struct.name, functionClassInformations)
            }

            return [ functionHelpers ]
        })()
    }

    public async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.SignatureHelpContext,
    ) {
        const codeAtLine = document.lineAt(position.line).text.substr(0, position.character)
        const codeString = codeAtLine.match(/([\w.:]+)\(([\w"',\s.:(-]*)(\))?$/)

        if (codeString !== null) {
            const indexString = codeString[1]
            const parameters = codeString[2]
            const completed = codeString[3] // Match a close parentheses
            if (completed) {
                return null
            }

            const types = await inferType(document, position, indexString.trim())

            let memberType = types[types.length - 1]
            let classType = types[types.length - 2]
            let isEvent = false
            if (memberType.Name === "RobloxScriptConnection" &&
                (memberType.VariableName === "Connect" || memberType.VariableName === "connect")) {
                memberType = types[types.length - 2]
                classType = types[types.length - 3]
                isEvent = true
            }

            if (memberType === null || classType === null) {
                return
            }

            const [ functionHelpers, eventHelpers ] =
                classType.Category === "Class" ? await this.classHelpers : await this.structHelpers

            // Check if it is a function
            if (isEvent) {
                // Providing Event SignatureHelp
                if (eventHelpers) {
                    const actualParameters = parameters.match(/\s*function\s*\(([\w\s"',.-]*)$/)
                    if (actualParameters !== null && actualParameters[1] !== undefined) {
                        const klassInformation = eventHelpers.get(classType.Name)
                        if (klassInformation !== undefined) {
                            const memberInformation = klassInformation[memberType.VariableName]
                            if (memberInformation !== undefined && memberInformation.length > 0) {
                                const signatureHelp = new vscode.SignatureHelp()
                                const paramSplit = actualParameters[1].split(",")
                                signatureHelp.signatures = memberInformation
                                signatureHelp.activeParameter = paramSplit.length - 1
                                return signatureHelp
                            }
                        }
                    }
                }
            } else {
                // Provide function signatureHelp
                const klassInformation = functionHelpers.get(classType.Name)
                if (klassInformation !== undefined) {
                    const memberInformation = klassInformation[memberType.VariableName]
                    if (memberInformation !== undefined && memberInformation.length > 0) {
                        const signatureHelp = new vscode.SignatureHelp()
                        const paramSplit = parameters.split(",")
                        signatureHelp.signatures = memberInformation
                        signatureHelp.activeParameter = paramSplit.length - 1
                        return signatureHelp
                    }
                }
            }
        }
    }
}
