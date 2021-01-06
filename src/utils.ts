import * as vscode from "vscode"
import { AutocompleteGroup, AutocompleteParameter, getAutocompleteDump } from "./autocompleteDump"
import { ApiClass, ApiMember, ApiParameter, ApiValueType, getApiDump } from "./dump"

export const CLASS_ALIASES: { [name: string]: string } = {
    game: "DataModel",
    workspace: "Workspace",
}

export const getServices: Promise<Map<string, ApiClass>> = (async () => {
    const apiDump = await getApiDump()
    const output = new Map()

    for (const klass of apiDump.Classes) {
        if (klass.Tags !== undefined && klass.Tags.includes("Service")) {
            output.set(klass.Name, klass)
        }
    }

    return output
})()

export const createParameterLabel = (parameter: ApiParameter) =>
    `${parameter.Name}${parameter.Default ? "?" : ""}: ${parameter.Type ? parameter.Type.Name : "unknown"}${parameter.Default ? ` = ${parameter.Default}` : ""}`

export const createStructParameterLabel = (parameter: AutocompleteParameter) =>
    `${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.type || "unknown"}`

export const createDocumentationString = (
  member: ApiMember, type: "Function" | "Callback" | "Property" | "Event", serviceName: string,
) => {
    let value = member.Description || ""
    if (member.Inherited) {
        value += `${value !== "" ? "\n\n" : ""}[Inherited from ${member.Inherited}]`
    }
    value += `${value !== "" ? "\n\n" : ""}[Developer Reference](https://developer.roblox.com/en-us/api-reference/${type.toLowerCase()}/${member.Inherited || serviceName}/${member.Name})`
    return new vscode.MarkdownString(value)
}

const isVariableClass = (variable: ApiClass | AutocompleteGroup): variable is ApiClass => {
    return (variable as ApiClass).Name !== undefined
}

export interface ValueType extends ApiValueType {
    VariableName: string,
    Static: boolean,
}

// Heuristic method in order to infer the type of parts of a codeblock
// Codeblocks can be things like `Lighting.Ambient.R`
export const inferType = async (document: vscode.TextDocument, position: vscode.Position, code: string) => {
    const codeSplit = code.split(/[.:]/)
    // TODO: This split will break if there are points within a function call, eg. Lighting.Ambient:Lerp(CFrame.new()).R

    const apiDump = await getApiDump()
    const autocompleteDump = await getAutocompleteDump()
    const services = await getServices

    const output: ValueType[] = [] // new Map<string, ApiValueType>()
    let lastVariableInfo: ApiClass | AutocompleteGroup | undefined

    // Determine first part of the chain, need to determine what type it is
    // This can be done by checking if its a Service
    // or by looking above the line for variable assignment
    const firstVariable = codeSplit.shift() as string

    // Check for a predefined alias to a class for this variable
    if (CLASS_ALIASES[firstVariable]) {
        const actualClass = apiDump.Classes.find(klass => klass.Name === CLASS_ALIASES[firstVariable])
        if (actualClass) {
            lastVariableInfo = actualClass
            output.push({ VariableName: firstVariable, Category: "Class", Name: actualClass.Name, Static: false })
        }
    }

    // Search services for the variable
    if (lastVariableInfo === undefined) {
        const service = services.get(firstVariable)
        if (service) {
            lastVariableInfo = service
            output.push({ VariableName: firstVariable, Category: "Class", Name: service.Name, Static: false })
        }
    }

    // Search ItemStructs for the variable
    if (lastVariableInfo === undefined) {
        const itemStruct = autocompleteDump.ItemStruct.find(struct => struct.name === firstVariable)
        if (itemStruct) {
            lastVariableInfo = itemStruct
            output.push({ VariableName: firstVariable, Category: "DataType", Name: itemStruct.name, Static: true })
        }
    }

    // Check for variable assignment before this line
    // NOTE: This test has no knowledge of scope, it will just return the last defined variable
    // FIXME: Generate an AST and parse this for scope instead?
    if (lastVariableInfo === undefined) {
        const text = document.getText(new vscode.Range(new vscode.Position(0, 0), position))
        // Find all the lines where this variable is defined
        const variableStringMatch = text.match(new RegExp(`^\\s*local\\s+${firstVariable}\\s*=\\s*(.*)`, "mg"))
        if (variableStringMatch !== null) {
            // Get the last line it was defined on (assuming this is the best definition)
            const lastString = variableStringMatch[variableStringMatch.length - 1]
            const codeString = lastString.match(new RegExp(`^\\s*local\\s+${firstVariable}\\s*=\\s*(.*)`, "m"))
            if (codeString !== null) {
                // If it is a long string, find the latest type
                const types = await inferType(document, position, codeString[1])
                if (types.length > 0) {
                    const lastType = types[types.length - 1]
                    output.push(lastType)

                    if (lastType.Category === "Class") {
                        lastVariableInfo = apiDump.Classes.find(k => k.Name === lastType.Name)
                    } else if (lastType.Category === "DataType") {
                        lastVariableInfo = autocompleteDump.ItemStruct.find(struct => struct.name === lastType.Name)
                    }
                }
            }
        }
    }

    if (lastVariableInfo === undefined) {
        // Could not determine the first variable
        // Just return an empty array
        return output
    }

    while (codeSplit.length > 0) {
        const variable = codeSplit.shift() as string
        if (lastVariableInfo !== undefined) {
            if (isVariableClass(lastVariableInfo)) {
                // lastVariableInfo is a Class from the API Dump
                const memberNameMatch = variable.match(/(\w+)\(?.*\)?/) // Need to match out the parentheses and params
                if (memberNameMatch === null) {
                    // Cannot retrieve a member name
                    // Breaking the loop
                    break
                }

                const member = lastVariableInfo.Members.find(mem => mem.Name === memberNameMatch[1])
                if (member) {
                    if (member.MemberType === "Property" || member.MemberType === "Function") {
                        const outputType = member.MemberType === "Property" ? member.ValueType : member.ReturnType
                        output.push({...outputType, VariableName: variable, Static: false})

                        if (outputType.Category === "Class") {
                            const info = apiDump.Classes.find(klass => klass.Name === outputType.Name)
                            if (info !== undefined) {
                                lastVariableInfo = info
                            } else {
                                // Cannot find class, therefore cannot infer type
                                break
                            }
                        } else if (outputType.Category === "DataType") {
                            const info = autocompleteDump.ItemStruct.find(
                                struct => struct.name === outputType.Name)
                            if (info !== undefined) {
                                lastVariableInfo = info
                            } else {
                                // Cannot find DataType, therefore cannot infer type
                                break
                            }
                        } else {
                            // This value is most likely a primitive or an Enum
                            // There is nothing we can really infer from here, therefore we will break
                            // TODO: look into seeing if there is more we can infer
                            break
                        }
                    } else if (member.MemberType === "Event") {
                        // Return an EventInstance DataType
                        output.push({ VariableName: variable, Category: "DataType", Name: "EventInstance", Static: false })

                        lastVariableInfo = autocompleteDump.ItemStruct.find(struct => struct.name === "EventInstance")
                        if (lastVariableInfo === undefined) {
                            // Break if EventInstance couldn't be found, as the type cannot be inferred
                            break
                        }
                    }
                } else {
                    // Can no longer infer a type
                    // Break the loop and return the output
                    break
                }
            } else {
                // lastVariableInfo is an ItemStruct from the Autocomplete Dump
                // Check to see if it is a property
                const previousItem = output[output.length - 1]
                const property = lastVariableInfo.properties.find(
                    prop => prop.name === variable && prop.static === previousItem.Static)

                if (property !== undefined) {
                    // Check if the property is a class
                    const classInfo = apiDump.Classes.find(klass => klass.Name === property.type)
                    if (classInfo !== undefined) {
                        // The property is a Class
                        lastVariableInfo = classInfo
                        output.push({ VariableName: variable, Category: "Class", Name: classInfo.Name, Static: false })
                        continue
                    }

                    // Check if the property is a DataType
                    // const dataTypeInfo = autocompleteDump.ItemStruct.find(
                    //     struct => struct.name === property.type)
                    if (dataTypeInfo !== undefined) {
                        // The property is a DataType
                        lastVariableInfo = dataTypeInfo
                        output.push({ VariableName: variable, Category: "DataType", Name: dataTypeInfo.name, Static: false })
                        continue
                    }

                    // The property type must be a primitive then
                    output.push({ VariableName: variable, Category: "Primitive", Name: property.type, Static: false })

                    // Cannot infer any more types
                    // Breaking the loop
                    break
                }

                // Check to see if it is a function
                // Need to match the functionName to exclude parentheses and parameters
                const functionNameMatch = variable.match(/(\w+)\(?(.*)\)?/)
                if (functionNameMatch !== null) {
                    const functionName = functionNameMatch[1]
                    const func = lastVariableInfo.functions.find(
                        f => f.name === functionName && f.static === previousItem.Static,
                    )

                    if (func) {
                        // Special test for Instance.new(x)
                        if (lastVariableInfo.name === "Instance" && func.name === "new") {
                            const actualClass = variable.match(/new\(["'](\w+)["']\)/)
                            if (actualClass !== null) {
                                const classInfo = apiDump.Classes.find(klass => klass.Name === actualClass[1])
                                if (classInfo) {
                                    lastVariableInfo = classInfo
                                    output.push({ VariableName: variable, Category: "Class", Name: classInfo.Name, Static: false })
                                    continue
                                }
                            }
                        }

                        const returns = func.returns[0] // Only taking the first return type for the time being
                        if (returns) {
                            // Check if the property is a classs
                            const classInfo = apiDump.Classes.find(klass => klass.Name === returns.type)
                            if (classInfo) {
                                // The function returns a Class
                                lastVariableInfo = classInfo
                                output.push({ VariableName: variable, Category: "Class", Name: classInfo.Name, Static: false })
                                continue
                            }

                            // Check if the property is a DataType
                            const dataTypeInfo = autocompleteDump.ItemStruct.find(
                                struct => struct.name === returns.type)
                            if (dataTypeInfo) {
                                // The function returns a DataType
                                lastVariableInfo = dataTypeInfo
                                output.push({ VariableName: variable, Category: "DataType", Name: dataTypeInfo.name, Static: false })
                                continue
                            }

                            // The property type must be a primitive then
                            output.push({ VariableName: variable, Category: "Primitive", Name: returns.type, Static: false })

                            // Cannot infer any more types
                            // Breaking the loop
                            break
                        }

                        // No return variable, therefore no types to infer
                        break
                    }
                }

                // Could not find a member of DataType which matches
                // Breaking the loop
                break
            }
        } else {
            // No longer a present lastVariableInfo
            // Therefore, break the loop
            break
        }
    }

    return output
}
