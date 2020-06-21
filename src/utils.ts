import * as vscode from "vscode"
import { AutocompleteGroup, AutocompleteParameter, getAutocompleteDump } from "./autocompleteDump"
import { ApiClass, ApiMember, ApiParameter, ApiValueType, getApiDump } from "./dump"

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
  member: ApiMember, type: "function" | "callback" | "property" | "event", serviceName: string,
) => {
    let value = member.Description || ""
    if (member.Inherited) {
        value += `${value !== "" ? "\n\n" : ""}[Inherited from ${member.Inherited}]`
    }
    value += `${value !== "" ? "\n\n" : ""}[Developer Reference](https://developer.roblox.com/en-us/api-reference/${type}/${member.Inherited || serviceName}/${member.Name})`
    return new vscode.MarkdownString(value)
}

export const CLASS_ALIASES: { [name: string]: string } = {
    game: "DataModel",
    workspace: "Workspace",
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
export const inferType = async (document: vscode.TextDocument | null, code: string) => {
    const codeSplit = code.split(/[.:]/)
    // TODO: This split will break if there are points within a function call, eg. Lighting.Ambient:Lerp(CFrame.new()).R

    const apiDump = await getApiDump()
    const autocompleteDump = await getAutocompleteDump()
    const services = await getServices

    const output: ValueType[] = [] // new Map<string, ApiValueType>()

    let lastVariableInfo: ApiClass | AutocompleteGroup | undefined
    while (codeSplit.length > 0) {
        const variable = codeSplit.shift() as string

        if (lastVariableInfo) {
            if (isVariableClass(lastVariableInfo)) {
                // lastVariableInfo is a Class from the API Dump
                const memberNameMatch = variable.match(/(\w+)\(?.*\)?/) // Need to match out the parentheses and params
                if (memberNameMatch === null) {
                    // Cannot retrieve a member name
                    // Breaking the loop
                    break
                }

                const member = lastVariableInfo.Members.find(member => member.Name === memberNameMatch[1])
                if (member) {
                    if (member.MemberType === "Property" || member.MemberType === "Function") {
                        const outputType = member.MemberType === "Property" ? member.ValueType : member.ReturnType
                        output.push({...outputType, VariableName: variable, Static: false})
                        if (outputType.Category === "Class") {
                            const info = apiDump.Classes.find(klass => klass.Name === outputType.Name)
                            if (info) {
                                lastVariableInfo = info
                            } else {
                                // Cannot find class, therefore cannot infer type
                                break
                            }
                        } else if (outputType.Category === "DataType") {
                            const info = autocompleteDump.ItemStruct.find(
                                struct => struct.name === outputType.Name)
                            if (info) {
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
                    property => property.name === variable && property.static === previousItem.Static)
                if (property) {
                    // Check if the property is a classs
                    const classInfo = apiDump.Classes.find(klass => klass.Name === property.type)
                    if (classInfo) {
                        // The property is a Class
                        lastVariableInfo = classInfo
                        output.push({ VariableName: variable, Category: "Class", Name: classInfo.Name, Static: false })
                        continue
                    }

                    // Check if the property is a DataType
                    const dataTypeInfo = autocompleteDump.ItemStruct.find(
                        struct => struct.name === property.type)
                    if (dataTypeInfo) {
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
                const functionNameMatch = variable.match(/(\w+)\(?.*\)?/)
                if (functionNameMatch !== null) {
                    const functionName = functionNameMatch[1]
                    const func = lastVariableInfo.functions.find(
                        f => f.name === functionName && f.static === previousItem.Static,
                    )

                    if (func) {
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
            // First part of chain, need to determine what type it is
            // This can be done by checking if its a Service
            // or by looking above the line for variable assignment

            // Check for a predefined alias to a class for this variable
            if (CLASS_ALIASES[variable]) {

                const klass = apiDump.Classes.find(k => k.Name === CLASS_ALIASES[variable])
                if (klass) {
                    lastVariableInfo = klass
                    output.push({ VariableName: variable, Category: "Class", Name: klass.Name, Static: false })
                    continue
                }
            }

            // Search services for the variable
            const service = services.get(variable)
            if (service) {
                lastVariableInfo = service
                output.push({ VariableName: variable, Category: "Class", Name: service.Name, Static: false })
                continue
            }

            // Search ItemStructs for the variable
            const itemStruct = autocompleteDump.ItemStruct.find(struct => struct.name === variable)
            if (itemStruct) {
                lastVariableInfo = itemStruct
                output.push({ VariableName: variable, Category: "DataType", Name: itemStruct.name, Static: true })
                continue
            }

            // TODO: Check for variable assignment

            // We were unable to find anything, so we just need to break
            break
        }
    }

    return output
}
