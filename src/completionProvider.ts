// Roblox Completion Provider
// Provides completion items for Classes and DataTypes, as well as properties with custom DataTypes

import * as vscode from "vscode"
import { getAutocompleteDump } from "./autocompleteDump"
import { ApiClass, ApiMember, ApiPropertySecurity, getApiDump, UNCREATABLE_TAGS } from "./dump"
import { createDocumentationString, createParameterLabel, createStructParameterLabel, inferType } from "./utils"

const UNSCRIPTABLE_TAGS: Set<string> = new Set([
    "Deprecated",
    "Hidden",
    "NotBrowsable",
    "NotScriptable",
])

const IMPORT_PATTERN = /^local \w+ = game:GetService\("\w+"\)\s*$/

const getAllowedClassMembers = (member: ApiMember) => {
    const tags = member.Tags
    if (tags !== undefined) {
        for (const tag of tags) {
            if (UNSCRIPTABLE_TAGS.has(tag)) {
                return false
            }
        }
    }
    return true
}

const getClassCompletionItemKind = (type: "Function" | "Callback" | "Event" | "Property") => {
    switch (type) {
        case "Function":
            return vscode.CompletionItemKind.Method
        case "Property":
            return vscode.CompletionItemKind.Field
        case "Callback":
            return vscode.CompletionItemKind.Constructor
        case "Event":
            return vscode.CompletionItemKind.Event
    }
}

const getClassCompletionItemDetail = (member: ApiMember, service: ApiClass) => {
    switch (member.MemberType) {
        case "Function":
            return `(method) ${service.Name}:${member.Name}(${member.Parameters.map(parameter => createParameterLabel(parameter)).join(", ")}): ${member.ReturnType ? member.ReturnType.Name : "unknown"}`
        case "Property":
            return `(property) ${service.Name}.${member.Name}: ${member.ValueType ? member.ValueType.Name : "unknown"}`
        case "Callback":
            return `(callback) ${service.Name}.${member.Name} = function (${member.Parameters.map(parameter => `${parameter.Name}: ${parameter.Type ? parameter.Type.Name : "unknown"}`).join(", ")})`
        case "Event":
            return `(event) ${service.Name}.${member.Name}(${member.Parameters.map(parameter => `${parameter.Name}: ${parameter.Type ? parameter.Type.Name : "unknown"}`).join(", ")})`
    }
}

export class RobloxCompletionProvider implements vscode.CompletionItemProvider {
    private classCompletion: Promise<Array<Map<string, vscode.CompletionItem[]>>>
    private structCompletion: Promise<Array<Map<string, vscode.CompletionItem[]>>>
    private itemStructNames: Promise<vscode.CompletionItem[]>

    constructor() {
        this.classCompletion = (async () => {
            const dotCompletion = new Map<string, vscode.CompletionItem[]>()
            const colonCompletion = new Map<string, vscode.CompletionItem[]>()

            const classes = (await getApiDump()).Classes
            for (const klass of classes) {
                const dotOperatorItems: vscode.CompletionItem[] = []
                const colonOperatorItems: vscode.CompletionItem[] = []

                for (const member of klass.Members.filter(getAllowedClassMembers)) {
                    if (member.MemberType === "Property") {
                        const security = member.Security as ApiPropertySecurity
                        if (security.Read !== "None" && security.Write !== "None") {
                            continue
                        }
                    } else if (member.Security !== "None") {
                        continue
                    }

                    const completionItem = new vscode.CompletionItem(
                        member.Name,
                        getClassCompletionItemKind(member.MemberType)
                    )
                    completionItem.detail = getClassCompletionItemDetail(member, klass)
                    completionItem.documentation = createDocumentationString(member, member.MemberType, klass.Name)

                    if (member.MemberType === "Function") {
                        colonOperatorItems.push(completionItem)
                    } else {
                        dotOperatorItems.push(completionItem)
                    }
                }

                dotCompletion.set(klass.Name, dotOperatorItems)
                colonCompletion.set(klass.Name, colonOperatorItems)
            }

            return [ dotCompletion, colonCompletion ]
        })()

        this.structCompletion = (async () => {
            const dotCompletion = new Map<string, vscode.CompletionItem[]>()
            const colonCompletion = new Map<string, vscode.CompletionItem[]>()

            const autocompleteDump = await getAutocompleteDump()

            for (const itemStruct of autocompleteDump.ItemStruct) {
                const dotOperatorItems: vscode.CompletionItem[] = []
                const colonOperatorItems: vscode.CompletionItem[] = []

                itemStruct.properties.map(property => {
                    const item = new vscode.CompletionItem(
                        property.name,
                        vscode.CompletionItemKind.Field,
                    )
                    item.detail = `(property) ${itemStruct.name}.${property.name}: ${property.type}`
                    item.documentation = new vscode.MarkdownString(`${property.description ? property.description + "\n\n" : ""}[Developer Reference](https://developer.roblox.com/en-us/api-reference/datatype/${itemStruct.name})`)
                    return item
                }).forEach(item => dotOperatorItems.push(item))

                const completedFuncs: { [name: string]: boolean } = {}

                itemStruct.functions.map(func => {
                    const item = new vscode.CompletionItem(
                        func.name,
                        func.static ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Method,
                    )
                    item.detail = `(${func.static ? "function" : "method"}) ${itemStruct.name}.${func.name}(${func.parameters.map(parameter => createStructParameterLabel(parameter)).join(", ")}): ${func.returns.length > 0 ? func.returns.map((ret) => ret.type).join(", ") : "unknown"}`
                    item.documentation = new vscode.MarkdownString(`${func.description ? func.description + "\n\n" : ""}[Developer Reference](https://developer.roblox.com/en-us/api-reference/datatype/${itemStruct.name})`)
                    return { item, func }
                }).forEach(
                    ({ item, func }) => {
                        // Merge together overloaded functions
                        if (completedFuncs[func.name] === undefined) {
                            const count = itemStruct.functions.filter(f => f.name === func.name).length
                            if (count > 1) {
                                item.detail += ` (+${count - 1} overload${count === 1 ? "" : "s"})`
                            }

                            func.static ? dotOperatorItems.push(item) : colonOperatorItems.push(item)
                            completedFuncs[func.name] = true
                        }
                    })

                dotCompletion.set(itemStruct.name, dotOperatorItems)
                colonCompletion.set(itemStruct.name, colonOperatorItems)
            }

            return [ dotCompletion, colonCompletion ]
        })()

        this.itemStructNames = (async () => {
            const autocompleteDump = await getAutocompleteDump()
            return autocompleteDump.ItemStruct.filter(
                (itemStruct) => {
                    return itemStruct.functions.filter(
                        func => func.static,
                    ).length > 0 || itemStruct.properties.filter((property) => property.static).length > 0
                },
            ).map(
                (itemStruct) => new vscode.CompletionItem(itemStruct.name, vscode.CompletionItemKind.Class),
            )
        })()
    }

    public async provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.CompletionContext,
    ) {
        const codeAtLine = document.lineAt(position.line).text.substr(0, position.character)
        const codeString = codeAtLine.match(/([\w.:()'"]+)([.:])([\w()"']*)$/)

        console.log(codeAtLine, codeString)

        if (codeString !== null) {
            const indexString = codeString[1]
            const operator = codeString[2]
            const extra = codeString[3]

            const types = await inferType(document, position, indexString)

            const mainType = types[types.length - 1]
            if (mainType === undefined) {
                return null
            }

            if (mainType.Category === "Class") {
                const apiDump = await getApiDump()
                const service = apiDump.Classes.find(klass => klass.Name === mainType.Name)
                if (service !== undefined && service.Tags !== undefined && service.Tags.includes("Service")) {
                    // Provide auto import if it is a service and is not already present
                    const documentText = document.getText()

                    if (!documentText.match(new RegExp(`^local ${service.Name}\\s*=\\s*`, "m"))) {
                        const insertText = `local ${service.Name} = game:GetService("${service.Name}")\n`
                        const lines = documentText.split(/\n\r?/)

                        const firstImport = lines.findIndex(line => line.match(IMPORT_PATTERN))
                        let lineNumber = Math.max(firstImport, 0)

                        while (lineNumber < lines.length) {
                            if (
                                !lines[lineNumber].match(IMPORT_PATTERN)
                                || lines[lineNumber] > insertText
                            ) {
                                break
                            }
                            lineNumber++
                        }

                        const item = new vscode.CompletionItem(
                            service.Name,
                            vscode.CompletionItemKind.Class,
                        )

                        item.additionalTextEdits = [
                            vscode.TextEdit.insert(
                                new vscode.Position(lineNumber, 0),
                                insertText + (firstImport === -1 ? "\n" : ""),
                            ),
                        ]

                        if (operator !== "") {
                            item.command = { command: "editor.action.triggerSuggest", title: "Re-trigger completions" }
                        }

                        item.detail = `Auto-import ${service.Name}`
                        item.documentation = new vscode.MarkdownString(`${service.Description ? service.Description + "\n\n" : ""}[Developer Reference](https://developer.roblox.com/en-us/api-reference/class/${service.Name})`)
                        item.insertText = operator ? "" : service.Name
                        item.preselect = true

                        return [item]
                    }
                }

                const [ dotCompletion, colonCompletion ] = await this.classCompletion
                if (operator === ".") {
                    return dotCompletion.get(mainType.Name)
                } else if (operator === ":") {
                    return colonCompletion.get(mainType.Name)
                }
            } else if (mainType.Category === "DataType") {
                const [ dotCompletion, colonCompletion ] = await this.structCompletion

                // Provide support for Instance.new() etc.
                if (extra !== null) {
                    const extraMatch = extra.match(/([\w.:]+)\(([\w"',\s.:()-]*)?$/)
                    if (extraMatch !== null) {
                        const functionName = extraMatch[1]
                        const parameters = extraMatch[2]

                        const itemStruct = (await getAutocompleteDump()).ItemStruct.find(struct => struct.name === mainType.Name)
                        const itemStructFunc = itemStruct?.functions.find(func => func.name === functionName)
                        const parameter = itemStructFunc?.parameters[parameters.split(",").length - 1]

                        if (parameter !== undefined && parameter.constraint !== undefined) {
                            const constraintSplit = parameter.constraint.split(":")
                            const objectType = constraintSplit[0]
                            const constraint = constraintSplit[1] || "any"

                            const apiDump = await getApiDump()
                            const options = apiDump.Classes.filter(klass => {
                                if (objectType === "Instance") {
                                    if (constraint === "any") {
                                        return true
                                    } else if (constraint === "isScriptCreatable") {
                                        const tags = klass.Tags
                                        if (tags) {
                                            for (const tag of tags) {
                                                if (UNCREATABLE_TAGS.has(tag)) {
                                                    return false
                                                }
                                            }
                                        }
                                        return true
                                    }
                                }
                                return false
                            }).map(klass => {
                                const completionItem = new vscode.CompletionItem(
                                    klass.Name,
                                    vscode.CompletionItemKind.Constant,
                                )

                                completionItem.documentation = new vscode.MarkdownString(`${klass.Description ? klass.Description + "\n\n" : ""}[Developer Reference](https://developer.roblox.com/en-us/api-reference/class/${klass.Name})`)
                                return completionItem
                            })

                            return options
                        }
                        return null
                    }
                }

                if (operator === ".") {
                    if (mainType.Static === true) {
                        return dotCompletion.get(mainType.Name)?.filter(item => item.kind === vscode.CompletionItemKind.Function)
                    } else {
                        return dotCompletion.get(mainType.Name)?.filter(item => item.kind !== vscode.CompletionItemKind.Function)
                    }
                } else if (operator === ":" && mainType.Static === false) {
                    return colonCompletion.get(mainType.Name)
                }
            }

            return null
        } else {
            // Provide completion items for creatable DataTypes
            return this.itemStructNames
        }
    }
}